import type { Command } from "commander";
import { resolveHarborOuterSandbox } from "../benchmarks/swebench.js";
import { inspectBenchmarkBridge } from "./benchmark-backend.js";
import { executionCapabilities } from "./capabilities.js";
import { NativeSandboxStartupService } from "./native-startup.js";
import { loadEasyCodeConfig } from "../config/loader.js";
import { SandboxRecovery } from "./recovery.js";

import {
  formatSandboxReadiness,
  sandboxIsReady,
  type SandboxStartupService,
} from "./startup.js";

export interface SandboxCommandRegistrationOptions {
  readonly service?: SandboxStartupService;
  readonly stdout?: Pick<NodeJS.WritableStream, "write">;
  readonly setExitCode?: (code: number) => void;
}

export function registerSandboxCommands(
  program: Command,
  options: SandboxCommandRegistrationOptions = {},
): Command {
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code: number) => {
    process.exitCode = code;
  });
  const writeLine = (value: string): void => {
    stdout.write(`${value}\n`);
  };
  const service: SandboxStartupService = options.service ?? {
    inspect: async () => {
      const config = await loadEasyCodeConfig({ credentialStore: false });
      return new NativeSandboxStartupService(config.limits, config.dataDir).inspect();
    },
    setup: async readiness => {
      const config = await loadEasyCodeConfig({ credentialStore: false });
      return new NativeSandboxStartupService(config.limits, config.dataDir, writeLine).setup(readiness);
    },
  };
  const writeReadiness = (
    readiness: Awaited<ReturnType<SandboxStartupService["inspect"]>>,
  ): void => {
    for (const line of formatSandboxReadiness(readiness)) writeLine(line);
  };

  const sandbox = program
    .command("sandbox")
    .description("set up or diagnose the native operating-system command sandbox");
  sandbox.command("recover").description("inspect interrupted native commands; never replays commands or guesses an unknown outcome")
    .option("--workspace <path>", "workspace to inspect", process.cwd())
    .option("--apply", "clear only leases proven inactive by recorded identity and engine inspection")
    .action(async (flags: { workspace: string; apply?: boolean }) => {
      if (resolveHarborOuterSandbox() === "harbor") throw new Error("Harbor owns benchmark command recovery");
      const config = await loadEasyCodeConfig({ credentialStore: false });
      const result = await new SandboxRecovery(config.dataDir, config.limits).inspect(flags.workspace, flags.apply);
      writeLine(JSON.stringify(result, null, 2));
      if (result.items.some(item => item.status === "blocked") || result.quarantine === "preserved") setExitCode(2);
    });
  sandbox.command("capabilities")
    .description("show backend policy capabilities (not a live toolchain compatibility test)")
    .action(() => {
      const backend = resolveHarborOuterSandbox() === "harbor" ? "benchmark-container" : "native";
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
