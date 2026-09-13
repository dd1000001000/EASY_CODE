import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import * as sandbox from "../src/sandbox/index.js";
import { loadEasyCodeConfig } from "../src/config/loader.js";
import { describe, it } from "./harness.js";

describe("Podman-only sandbox migration", () => {
  it("does not ship the retired backend, probes, repair entry points or npm dependency", async () => {
    assert.equal(sandbox.DefaultSandboxStartupService, sandbox.PodmanStartupService);
    assert.equal("AnthropicSandboxBackend" in sandbox, false);
    assert.equal("DefaultWindowsWorkspaceRepairService" in sandbox, false);
    for (const relative of ["src/sandbox/anthropic-backend.ts", "src/sandbox/sandbox-worker.ts",
      "src/sandbox/harbor-backend.ts", "src/sandbox/windows-workspace-repair.ts", "scripts/harbor-sandbox.c"])
      assert.equal(existsSync(path.join(process.cwd(), relative)), false, relative);
    for (const filename of ["package.json", "npm-shrinkwrap.json"])
      assert.doesNotMatch(await readFile(filename, "utf8"), /@anthropic-ai\/sandbox-runtime/u);
    const program = new Command();
    const registered = sandbox.registerSandboxCommands(program);
    assert.deepEqual(registered.commands.map(command => command.name()).sort(), ["capabilities", "doctor", "remove", "resources", "setup"]);
  });
  it("ignores retired saved ACL budgets without restoring them to the runtime config", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-podman-config-"));
    try {
      const userConfigPath = path.join(directory, "config.toml");
      await writeFile(userConfigPath, '[limits]\nsandboxCleanupMaxEntries=100000\nsandboxCleanupMaxDepth=128\npodmanCpus=3\n');
      const config = await loadEasyCodeConfig({ cwd: directory, userConfigPath, credentialStore: false,
        workspaceConfigPath: path.join(directory, "missing.toml"), env: {} });
      assert.equal(config.limits.podmanCpus, 3);
      assert.equal("sandboxCleanupMaxEntries" in config.limits, false);
      assert.equal("sandboxCleanupMaxDepth" in config.limits, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
