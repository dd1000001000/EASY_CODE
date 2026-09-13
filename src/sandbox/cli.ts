import type { Command } from "commander";
import { resolveHarborOuterSandbox } from "../benchmarks/swebench.js";
import { inspectBenchmarkBridge } from "./benchmark-backend.js";
import { executionCapabilities } from "./capabilities.js";
import { PodmanStartupService } from "./podman-startup.js";
import { loadEasyCodeConfig } from "../config/loader.js";
import path from "node:path";
import { PodmanResourceManager, type PodmanResourceKind } from "./podman-resources.js";

import {
  formatSandboxReadiness,
  sandboxIsReady,
  type SandboxStartupService,
} from "./startup.js";

export interface SandboxCommandRegistrationOptions {
  readonly service?: SandboxStartupService;
  readonly stdout?: Pick<NodeJS.WritableStream, "write">;
  readonly setExitCode?: (code: number) => void;
  readonly resources?: Pick<PodmanResourceManager, "list" | "remove">;
}

export function registerSandboxCommands(
  program: Command,
  options: SandboxCommandRegistrationOptions = {},
): Command {
  const service: SandboxStartupService = options.service ?? {
    inspect: async () => new PodmanStartupService((await loadEasyCodeConfig({ credentialStore: false })).limits).inspect(),
    setup: async readiness => new PodmanStartupService((await loadEasyCodeConfig({ credentialStore: false })).limits).setup(readiness),
  };
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code: number) => {
    process.exitCode = code;
  });
  const writeLine = (value: string): void => {
    stdout.write(`${value}\n`);
  };
  const writeReadiness = (
    readiness: Awaited<ReturnType<SandboxStartupService["inspect"]>>,
  ): void => {
    for (const line of formatSandboxReadiness(readiness)) writeLine(line);
  };

  const sandbox = program
    .command("sandbox")
    .description("set up or diagnose the Podman Linux task sandbox");
  const resources = async () => {
    if (resolveHarborOuterSandbox() === "harbor") throw new Error("Benchmark resource lifecycle belongs to Harbor; no nested Podman maintenance");
    if (options.resources) return options.resources;
    const config = await loadEasyCodeConfig({ credentialStore: false });
    return new PodmanResourceManager(path.join(config.dataDir, "podman"), config.limits);
  };
  sandbox.command("resources").description("list EASY CODE-owned containers, review volumes and snapshot images")
    .action(async () => writeLine(JSON.stringify(await (await resources()).list(), null, 2)));
  sandbox.command("remove <kind> <name>")
    .description("remove one stopped/unused owned resource; kind: container, volume or image; never removes logs or the Podman machine")
    .option("--yes", "confirm permanent removal of this exact resource and its retained dependencies")
    .action(async (kind: string, name: string, flags: { yes?: boolean }) => {
      if (!["container", "volume", "image"].includes(kind)) throw new Error("kind must be container, volume or image");
      if (!flags.yes) throw new Error(`Inspect sandbox resources first, then repeat with --yes to confirm removal of ${kind} ${name}`);
      await (await resources()).remove(kind as PodmanResourceKind, name);
      writeLine(`Removed ${kind} ${name}. Its container/volume contents are not recoverable without a backup. Workspace files and history were preserved.`);
    });

  sandbox.command("capabilities")
    .description("show backend policy capabilities (not a live toolchain compatibility test)")
    .action(() => {
      const backend = resolveHarborOuterSandbox() === "harbor" ? "benchmark-container" : "podman";
      writeLine(JSON.stringify({ backend, ...executionCapabilities(backend) }, null, 2));
    });

  sandbox
    .command("doctor")
    .description("check whether the OS sandbox can enforce command boundaries")
    .action(async () => {
      if (!options.service && resolveHarborOuterSandbox() === "harbor") {
        try { writeLine(await inspectBenchmarkBridge()); }
        catch (error) { writeLine(`Harbor sandbox unavailable: ${String(error)}`); setExitCode(2); }
        return;
      }
      const readiness = await service.inspect();
      writeReadiness(readiness);
      if (!sandboxIsReady(readiness)) setExitCode(2);
    });

  sandbox
    .command("setup")
    .description("install fixed prerequisites or perform required one-time sandbox setup")
    .action(async () => {
      writeLine("Checking the command sandbox before setup...");
      const before = await service.inspect();
      const result = await service.setup(before);
      writeLine(result.message);
      writeReadiness(result.readiness);
      if (!sandboxIsReady(result.readiness)) setExitCode(2);
    });

  sandbox.action(() => sandbox.outputHelp());
  return sandbox;
}
