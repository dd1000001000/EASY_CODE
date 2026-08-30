import type { Command } from "commander";

import {
  DefaultSandboxStartupService,
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
  const service = options.service ?? new DefaultSandboxStartupService();
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
    .description("set up or diagnose the Anthropic OS sandbox");

  sandbox
    .command("doctor")
    .description("check whether the OS sandbox can enforce command boundaries")
    .action(async () => {
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
