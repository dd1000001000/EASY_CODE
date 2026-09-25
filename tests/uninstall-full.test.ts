import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFilePlan, type UninstallPlan } from "../src/uninstall/plan.js";
import { activeOwners, executeUninstall } from "../src/uninstall/execute.js";
import { runUninstall } from "../src/uninstall/cli.js";
import { addCredentials } from "../src/uninstall/integrations.js";
import { recordOwnedResource } from "../src/install/ownership.js";
import { PACKAGED_MODEL_REGISTRY_SOURCE } from "../src/models/catalog.js";
import { EASY_CODE_BENCHMARK_KEYRING_SERVICE, EASY_CODE_KEYRING_SERVICE } from "../src/config/credentials.js";
import { currentProcessIdentity } from "../src/core/process-owner.js";
import { describe, it } from "./harness.js";

function put(file: string, value = "data") { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); }
async function fixture(run: (value: { root: string; home: string; data: string; config: string; cache: string;
  plan(): Promise<UninstallPlan> }) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-native-uninstall-"));
  const home = path.join(root, "home"), data = path.join(root, "data"), config = path.join(root, "config"), cache = path.join(root, "cache");
  mkdirSync(home);
  try { await run({ root, home, data, config, cache,
    plan: () => buildFilePlan({ home, paths: { data, config, cache } }) }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe("native full uninstall", () => {
  it("clears built-in keyring slots even when the installation manifest has no credential receipts", async () => fixture(async f => {
    const stored = new Set([
      `${EASY_CODE_KEYRING_SERVICE}/glm.api-key`,
      `${EASY_CODE_KEYRING_SERVICE}/glm-coding-plan.api-key`,
      `${EASY_CODE_BENCHMARK_KEYRING_SERVICE}/glm-coding-plan.api-key`,
    ]);
    const removed: string[] = [];
    const plan = await buildFilePlan({ home: f.home });
    await addCredentials(plan, async (service, slot) => { removed.push(`${service}/${slot}`); stored.delete(`${service}/${slot}`); });
    assert.equal(plan.blockers.length, 0);
    assert.ok(plan.actions.some(action => action.id === `credential:${EASY_CODE_KEYRING_SERVICE}:glm.api-key`));
    assert.ok(plan.actions.some(action => action.id === `credential:${EASY_CODE_BENCHMARK_KEYRING_SERVICE}:glm-coding-plan.api-key`));

    const preview: string[] = [];
    await runUninstall({ dryRun: true }, { prepare: async () => plan, owners: async () => [],
      execute: async () => { throw new Error("dry-run executed a removal"); }, interactive: false,
      write: value => preview.push(value), question: async () => "" });
    assert.deepEqual(removed, []);
    assert.ok(preview.some(line => line.includes("glm-coding-plan.api-key")));

    await executeUninstall(plan, { activity: async () => [] });
    assert.equal(stored.size, 0);
    assert.equal(removed.filter(slot => slot === `${EASY_CODE_KEYRING_SERVICE}/glm.api-key`).length, 1);
    await executeUninstall(plan, { activity: async () => [] });
    assert.equal(stored.size, 0);
  }));

  it("includes valid custom providers and manifest receipts without trusting a broken registry", async () => fixture(async f => {
    const config = path.join(f.home, ".easy_code");
    put(path.join(config, "models.toml"), PACKAGED_MODEL_REGISTRY_SOURCE + `\n[providers.custom]\nname = "Custom"\nbase_url = "https://example.com/v1"\nenv_key = "CUSTOM_API_KEY"\nwire_api = "responses"\n\n[models.custom-default]\nname = "Custom"\nprovider = "custom"\nmodel = "custom-model"\ninput_modalities = ["text"]\ntool_calling = true\nreasoning = false\n`);
    recordOwnedResource({ kind: "config", path: config }, f.home);
    recordOwnedResource({ kind: "credential", name: "retired.api-key" }, f.home);
    recordOwnedResource({ kind: "credential", name: "retired.api-key", connection: EASY_CODE_BENCHMARK_KEYRING_SERVICE }, f.home);
    const plan = await buildFilePlan({ home: f.home });
    await addCredentials(plan, async () => {});
    assert.ok(plan.actions.some(action => action.id === `credential:${EASY_CODE_KEYRING_SERVICE}:custom.api-key`));
    assert.ok(plan.actions.some(action => action.id === `credential:${EASY_CODE_KEYRING_SERVICE}:retired.api-key`));
    assert.ok(plan.actions.some(action => action.id === `credential:${EASY_CODE_BENCHMARK_KEYRING_SERVICE}:retired.api-key`));
    assert.equal(new Set(plan.actions.map(action => action.id)).size, plan.actions.length);

    put(path.join(config, "models.toml"), "not valid TOML = [");
    const broken = await buildFilePlan({ home: f.home });
    await addCredentials(broken, async () => {});
    assert.ok(broken.actions.some(action => action.id === `credential:${EASY_CODE_KEYRING_SERVICE}:glm.api-key`));
    assert.ok(broken.actions.some(action => action.id === `credential:${EASY_CODE_KEYRING_SERVICE}:retired.api-key`));
    assert.ok(broken.warnings.some(warning => warning.includes("unregistered custom-provider")));
  }));

  it("keeps user data and the CLI when credential removal fails", async () => fixture(async f => {
    let removedData = false;
    const plan: UninstallPlan = { home: f.home, resources: [], warnings: [], blockers: [],
      roots: { data: [], config: [], cache: [] }, actions: [{ id: "data", phase: 60, target: f.data,
        description: "Delete data", execute: async () => { removedData = true; } }] };
    await addCredentials(plan, async (service, slot) => {
      if (service === EASY_CODE_KEYRING_SERVICE && slot === "glm.api-key") throw new Error("keyring locked");
    });
    await assert.rejects(executeUninstall(plan, { activity: async () => [] }), /pending step/u);
    assert.equal(removedData, false);
  }));

  it("removes native Runtime state without inspecting or removing VM/container software", async () => fixture(async f => {
    put(path.join(f.data, "native-sandbox", "runtime-home", "state.json"));
    put(path.join(f.data, "runtimes", "laya-decision", "pyvenv.cfg"));
    put(path.join(f.data, "threads", "one", "events.jsonl"));
    put(path.join(f.config, "config.toml"), "[limits]\nmaxContextTokens=1000000\n");
    put(path.join(f.cache, "models", "paraphrase-multilingual-MiniLM-L12-v2", "model.onnx"));
    const project = path.join(f.root, "project", "source.ts"); put(project, "keep");
    const plan = await f.plan();
    assert.equal(plan.blockers.length, 0, plan.blockers.join("\n"));
    assert.ok(plan.actions.some(action => path.resolve(action.target) === path.resolve(f.data)));
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

  it("does not let an absent PID in an incomplete command lease block uninstall", async () => fixture(async f => {
    const absentPid = 999_999_999;
    put(path.join(f.data, "command-leases", "workspace-id", "legacy-command.lease"), JSON.stringify({
      commandId: "legacy-command", ownerPid: absentPid, state: "preparing",
    }));
    const owners = await activeOwners(await f.plan());
    assert.ok(!owners.includes(`Command PID ${absentPid}`));
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
