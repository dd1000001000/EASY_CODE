import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PodmanResourceManager } from "../src/sandbox/podman-resources.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import type { PodmanRunner } from "../src/sandbox/podman-client.js";
import { Command } from "commander";
import { registerSandboxCommands } from "../src/sandbox/cli.js";
import { describe, it } from "./harness.js";

describe("explicit Podman resource maintenance", () => {
  it("requires confirmation before touching an engine", async () => {
    let removed = false;
    const program = new Command().exitOverride();
    registerSandboxCommands(program, { resources: { list: async () => ({ containers: [], volumes: [], images: [] }),
      remove: async () => { removed = true; } } });
    await assert.rejects(program.parseAsync(["sandbox", "remove", "container", "easy-code-" + "a".repeat(32)], { from: "user" }), /--yes/);
    assert.equal(removed, false);
  });
  it("protects live commands, foreign resources and histories; removes only exact stopped resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ec-podman-resources-"));
    const owner = "a".repeat(64), name = `easy-code-${owner.slice(0, 32)}`, directory = path.join(root, owner);
    await mkdir(directory); await writeFile(path.join(directory, "history.json"), "retained");
    let exists = true, running = false, foreign = false;
    const calls: string[][] = [];
    const run: PodmanRunner = async args => {
      calls.push(args);
      if (args[1] === "inspect") return { exitCode: 0, stderr: "", stdout: JSON.stringify([{ Id: "id", Config: { Labels: { "io.easy-code.owner": foreign ? "b".repeat(64) : owner } }, State: { Running: running, Status: running ? "running" : "exited" } }]) };
      if (args[0] === "rm") { exists = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args[1] === "exists") return { exitCode: exists ? 0 : 1, stdout: "", stderr: "" };
      throw new Error("Unexpected engine action");
    };
    const manager = new PodmanResourceManager(root, DEFAULT_RUNTIME_LIMITS, run);
    try {
      await assert.rejects(manager.remove("container", "unrelated"), /exact/);
      running = true; await assert.rejects(manager.remove("container", name), /stopped/); running = false;
      await writeFile(path.join(directory, "command.lease"), "active");
      await assert.rejects(manager.remove("container", name), /Unfinished/);
      assert.equal(await readFile(path.join(directory, "command.lease"), "utf8"), "active");
      await rm(path.join(directory, "command.lease"));
      foreign = true; await assert.rejects(manager.remove("container", name)); foreign = false;
      assert.equal(calls.some(a => a[0] === "rm"), false);
      await manager.remove("container", name);
      assert.equal(exists, false);
      assert.deepEqual(calls.find(a => a[0] === "rm"), ["rm", name]);
      assert.equal(await readFile(path.join(directory, "history.json"), "utf8"), "retained");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
