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
    { version: 1, commandId, type: "execution_request_sent", payload: {}, at: new Date().toISOString() },
    { version: 1, commandId, type: "target_started", payload: {}, at: new Date().toISOString() },
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

  it("recovers a current structured target-spawn failure without replaying it", async () => {
    const f = await fixture(false);
    try {
      await writeFile(path.join(f.lifecycle, `${f.commandId}.lease`), JSON.stringify({ version: 2,
        commandId: f.commandId, ownerPid: process.pid, hostname: os.hostname(), threadId: "thread", turnId: "turn" }));
      const events = [
        { version: 1, commandId: f.commandId, type: "execution_request_sent", payload: {}, at: new Date().toISOString() },
        { version: 1, commandId: f.commandId, type: "target_spawn_error",
          payload: { message: "target process could not be created" }, at: new Date().toISOString() },
        { version: 1, commandId: f.commandId, type: "execution_exited",
          payload: { exitCode: 125, outcome: "spawn_failed" }, at: new Date().toISOString() },
        { version: 1, commandId: f.commandId, type: "cleanup_complete", payload: {}, at: new Date().toISOString() },
        { version: 1, commandId: f.commandId, type: "finished", payload: { status: "spawn_failed" }, at: new Date().toISOString() },
      ];
      await writeFile(path.join(f.lifecycle, `${f.commandId}.events.jsonl`), events.map(value => JSON.stringify(value)).join("\n") + "\n");
      const quarantineDir = path.join(f.data, "command-quarantine"); await mkdir(quarantineDir, { recursive: true });
      const quarantine = path.join(quarantineDir, `${workspaceIdFromRoot(f.workspace)}.json`);
      await writeFile(quarantine, JSON.stringify({ version: 2, backend: "native", workspace: path.resolve(f.workspace),
        reason: "target process could not be created" }));
      const recovery = new SandboxRecovery(f.data, DEFAULT_RUNTIME_LIMITS);
      assert.equal((await recovery.inspect(f.workspace)).items[0]?.status, "recoverable");
      const applied = await recovery.inspect(f.workspace, true);
      assert.equal(applied.items[0]?.status, "recovered");
      assert.equal(applied.quarantine, "cleared");
      await assert.rejects(readFile(path.join(f.lifecycle, `${f.commandId}.lease`)), { code: "ENOENT" });
      await assert.rejects(readFile(quarantine), { code: "ENOENT" });
      const journal = await readFile(path.join(f.lifecycle, `${f.commandId}.events.jsonl`), "utf8");
      assert.match(journal, /not_started_reconciled/u);
      assert.match(journal, /"replayed":false/u);
    } finally { await rm(f.data, { recursive: true, force: true }); }
  });
});
