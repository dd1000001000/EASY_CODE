import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harborPathRules, assertHarborHelper } from "../src/sandbox/harbor-backend.js";
import { SandboxControlStream, encodeSandboxControl } from "../src/sandbox/control.js";
import { describe, it } from "./harness.js";

describe("Harbor sandbox handoff", () => {
  it("does not activate on a normal host, even with a forged Harbor variable", async () => {
    if (process.platform === "linux") return; // Linux/Docker behavior is exercised by the real smoke.
    const old = process.env.EASY_CODE_OUTER_SANDBOX;
    process.env.EASY_CODE_OUTER_SANDBOX = "harbor";
    try { await assert.rejects(assertHarborHelper(), /Linux container/); }
    finally { if (old === undefined) delete process.env.EASY_CODE_OUTER_SANDBOX; else process.env.EASY_CODE_OUTER_SANDBOX = old; }
  });

  it("recognizes private Harbor lifecycle frames and confirms cleanup", () => {
    const stream = new SandboxControlStream("command_test", () => undefined, true);
    for (const event of [{ type: "ready", backend: "harbor-landlock" }, { type: "execution_dispatched" },
      { type: "execution_exited", exitCode: 0 }, { type: "cleanup_complete" }] as const)
      stream.push(encodeSandboxControl("command_test", event));
    assert.equal(stream.controls.length, 4);
  });

  it("does not grant ancestor file reads or protected-child removals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harbor-rules-"));
    try {
      await mkdir(path.join(root, "private")); await writeFile(path.join(root, "private", "secret"), "secret");
      await mkdir(path.join(root, "public")); await writeFile(path.join(root, "public", "file"), "ok");
      const deny = path.join(root, "private");
      const reads = await harborPathRules(root, [deny + path.sep], 13);
      assert.equal(reads.find(([, item]) => item === root)?.[0], 8);
      assert.ok(reads.some(([rights, item]) => rights === 13 && item === path.join(root, "public")));
      assert.ok(reads.every(([, item]) => !item.startsWith(deny)));
      const writes = await harborPathRules(root, [deny], 32754);
      assert.equal((writes.find(([, item]) => item === root)?.[0] ?? 0) & 48, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
