import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFilePlan, type UninstallPlan } from "../src/uninstall/plan.js";
import { activeOwners, executeUninstall } from "../src/uninstall/execute.js";
import { runUninstall } from "../src/uninstall/cli.js";
import { currentProcessIdentity } from "../src/core/process-owner.js";
import { describe, it } from "./harness.js";

function put(file: string, value = "data") { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); }
async function fixture(run: (value: { root: string; home: string; data: string; config: string; cache: string;
  plan(): Promise<UninstallPlan> }) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-native-uninstall-"));
  const home = path.join(root, "home"), data = path.join(root, "data"), config = path.join(root, "config"), cache = path.join(root, "cache");
  mkdirSync(home); const temporaryRoot = path.join(root, "tmp"); mkdirSync(temporaryRoot);
  try { await run({ root, home, data, config, cache,
    plan: () => buildFilePlan({ home, paths: { data, config, cache }, env: {}, temporaryRoot }) }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe("native full uninstall", () => {
  it("removes native Runtime state without inspecting or removing VM/container software", async () => fixture(async f => {
    put(path.join(f.data, "native-sandbox", "runtime-home", "state.json"));
    put(path.join(f.data, "threads", "one", "events.jsonl"));
    put(path.join(f.config, "config.toml"), "[limits]\nmaxContextTokens=1000000\n");
    put(path.join(f.cache, "models", "paraphrase-multilingual-MiniLM-L12-v2", "model.onnx"));
    const project = path.join(f.root, "project", "source.ts"); put(project, "keep");
    const plan = await f.plan();
    assert.equal(plan.blockers.length, 0, plan.blockers.join("\n"));
    assert.ok(plan.actions.some(action => action.target.includes("native-sandbox")));
    assert.ok(plan.actions.every(action => !/machine|container|podman|wsl/iu.test(action.description)));
    await executeUninstall(plan, { activity: async () => [] });
    assert.ok(!existsSync(f.data)); assert.ok(!existsSync(f.config)); assert.ok(!existsSync(f.cache));
    assert.equal(readFileSync(project, "utf8"), "keep");
  }));

  it("detects a live native command lease in the workspace-scoped journal", async () => fixture(async f => {
    put(path.join(f.data, "command-leases", "workspace-id", "command.lease"), JSON.stringify({
      version: 2, commandId: "command", ownerPid: process.pid, hostname: os.hostname(), processIdentity: currentProcessIdentity(),
    }));
    const owners = await activeOwners(await f.plan());
    assert.ok(owners.some(value => value === `Command PID ${process.pid}`));
  }));

  it("uses one confirmation and never invents a separate sandbox prompt", async () => {
    const seen: string[] = []; let executed = false;
    const plan: UninstallPlan = { actions: [{ id: "data", phase: 60, target: "fixture", description: "delete", execute: async () => {} }],
      warnings: [], blockers: [], roots: { data: [], config: [], cache: [] }, resources: [], home: os.homedir() };
    await runUninstall({}, { prepare: async () => plan, owners: async () => [], execute: async () => { executed = true; }, interactive: true,
      write: value => seen.push(value), question: async value => { seen.push(value); return "y"; } });
    assert.equal(executed, true);
    assert.equal(seen.filter(value => /\[y\/N\]/u.test(value)).length, 1);
    assert.ok(seen.every(value => !/machine|container|podman|wsl/iu.test(value)));
  });
});
