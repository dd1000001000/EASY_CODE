import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { BuiltinToolSource, BENCHMARK_DISABLED_TOOLS } from "../src/tools/builtin-source.js";
import { benchmarkHostOwner } from "../src/sandbox/benchmark-backend.js";
import type { CoordinationStore } from "../src/coordination/store.js";
import type { ThreadTitleStore } from "../src/threads/thread-title.js";

describe("Benchmark profile", () => {
  it("omits unrelated tools without changing the ordinary catalog", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-benchmark-profile-"));
    const workspace = await WorkspaceManager.create(root);
    try {
      const options = { workspace, coordination: {} as CoordinationStore, threadTitleStore: {} as ThreadTitleStore };
      const ordinary = (await new BuiltinToolSource(options).listTools()).map(tool => tool.name);
      const benchmark = (await new BuiltinToolSource({ ...options, profile: "benchmark" }).listTools()).map(tool => tool.name);
      for (const name of ["find_file_editors", "send_thread_message", "name_thread", "list_skills", "create_skill"])
        assert.ok(ordinary.includes(name));
      for (const name of benchmark) assert.ok(!BENCHMARK_DISABLED_TOOLS.has(name));
      for (const name of ["read_file", "create_file", "run_command", "poll_command", "read_memory", "compact_context", "manage_tasks"])
        assert.ok(benchmark.includes(name), name);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires an explicit valid host identity (or Windows ACL binding)", () => {
    assert.equal(benchmarkHostOwner(null), null);
    assert.deepEqual(benchmarkHostOwner({ uid: 1000, gid: 1001 }), { uid: 1000, gid: 1001 });
    for (const value of [undefined, {}, { uid: -1, gid: 0 }, { uid: "0", gid: 0 }, { uid: 1.5, gid: 0 }])
      assert.throws(() => benchmarkHostOwner(value), /ownership binding/u);
  });
});
