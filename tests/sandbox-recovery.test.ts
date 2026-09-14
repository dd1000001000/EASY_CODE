import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SandboxRecovery } from "../src/sandbox/recovery.js";
import { workspaceIdFromRoot } from "../src/storage/database.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { describe, it } from "./harness.js";

async function fixture(complete: boolean) {
  const data = await mkdtemp(path.join(os.tmpdir(), "easy-code-native-recovery-"));
  const workspace = path.join(data, "project");
  const lifecycle = path.join(data, "command-leases", workspaceIdFromRoot(workspace));
  const commandId = "command_recovery";
  await mkdir(lifecycle, { recursive: true });
  await writeFile(path.join(lifecycle, `${commandId}.lease`), JSON.stringify({ version: 2, commandId,
    ownerPid: 2_000_000_000, hostname: os.hostname(), threadId: "thread", turnId: "turn" }));
  const events = [
    { version: 1, commandId, type: "execution_dispatched", payload: {}, at: new Date().toISOString() },
    ...(complete ? [
      { version: 1, commandId, type: "execution_exited", payload: { exitCode: 0 }, at: new Date().toISOString() },
      { version: 1, commandId, type: "cleanup_complete", payload: {}, at: new Date().toISOString() },
      { version: 1, commandId, type: "finished", payload: { status: "exited" }, at: new Date().toISOString() },
    ] : []),
  ];
  await writeFile(path.join(lifecycle, `${commandId}.events.jsonl`), events.map(value => JSON.stringify(value)).join("\n") + "\n");
  return { data, workspace, lifecycle, commandId };
}

describe("native sandbox lifecycle reconciliation", () => {
  it("clears only an inactive lease with a trusted final outcome and completed cleanup", async () => {
    const f = await fixture(true);
    try {
      const recovery = new SandboxRecovery(f.data, DEFAULT_RUNTIME_LIMITS);
      assert.equal((await recovery.inspect(f.workspace)).items[0]?.status, "recoverable");
      assert.equal((await recovery.inspect(f.workspace, true)).items[0]?.status, "recovered");
      await assert.rejects(readFile(path.join(f.lifecycle, `${f.commandId}.lease`)), { code: "ENOENT" });
    } finally { await rm(f.data, { recursive: true, force: true }); }
  });

  it("preserves an unknown command and never replays it", async () => {
    const f = await fixture(false);
    try {
      const result = await new SandboxRecovery(f.data, DEFAULT_RUNTIME_LIMITS).inspect(f.workspace, true);
      assert.equal(result.items[0]?.status, "blocked");
      assert.match(result.items[0]!.reason, /outcome or cleanup is unknown/u);
      assert.ok(await readFile(path.join(f.lifecycle, `${f.commandId}.lease`)));
    } finally { await rm(f.data, { recursive: true, force: true }); }
  });

  it("preserves a torn lifecycle journal", async () => {
    const f = await fixture(true);
    try {
      await writeFile(path.join(f.lifecycle, `${f.commandId}.events.jsonl`), "{\"type\":\"interrupted\"");
      const result = await new SandboxRecovery(f.data, DEFAULT_RUNTIME_LIMITS).inspect(f.workspace, true);
      assert.equal(result.items[0]?.status, "blocked");
      assert.match(result.items[0]!.reason, /Truncated/u);
    } finally { await rm(f.data, { recursive: true, force: true }); }
  });
});
