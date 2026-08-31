import type { Command } from "commander";

import {
  DefaultSandboxStartupService,
  formatSandboxReadiness,
  sandboxIsReady,
  type SandboxStartupService,
} from "./startup.js";
import {
  DefaultWindowsWorkspaceRepairService,
  sameWindowsPath,
  type WindowsWorkspaceRepairPreview,
  type WindowsWorkspaceRepairService,
} from "./windows-workspace-repair.js";

export interface SandboxCommandRegistrationOptions {
  readonly service?: SandboxStartupService;
  readonly workspaceRepairService?: WindowsWorkspaceRepairService;
  readonly stdout?: Pick<NodeJS.WritableStream, "write">;
  readonly setExitCode?: (code: number) => void;
}

export function registerSandboxCommands(
  program: Command,
  options: SandboxCommandRegistrationOptions = {},
): Command {
  const service = options.service ?? new DefaultSandboxStartupService();
  const workspaceRepairService = options.workspaceRepairService ??
    new DefaultWindowsWorkspaceRepairService();
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

  sandbox
    .command("repair-workspace")
    .description("dry-run or repair Windows workspace ownership left by CodexSandboxOffline")
    .requiredOption("--target <absolute-path>", "exact workspace directory to inspect")
    .option("--apply", "apply only the owner changes shown by the dry-run through Windows UAC")
    .option(
      "--confirm <absolute-path>",
      "required with --apply; must exactly match the canonical workspace path",
    )
    .addHelpText(
      "after",
      "\nDry-run is the default. The repair never follows reparse points and changes only " +
        "CodexSandboxOffline-owned objects under the exact workspace. Existing DACL rules and " +
        "inheritance flags are preserved. --apply also requires --confirm and a Windows UAC prompt.\n",
    )
    .action(async (commandOptions: {
      target: string;
      apply?: boolean;
      confirm?: string;
    }) => {
      const preview = await workspaceRepairService.inspect(commandOptions.target);
      writeWorkspaceRepairPreview(writeLine, preview);
      if (!commandOptions.apply) {
        writeLine("Dry-run only; no owner or ACL was changed.");
        if (preview.inspectionErrors.length > 0) setExitCode(2);
        return;
      }
      if (!commandOptions.confirm) {
        throw new Error("--apply requires --confirm with the exact canonical workspace path.");
      }
      if (!sameWindowsPath(commandOptions.confirm, preview.target)) {
        throw new Error(
          `Confirmation path does not match the inspected workspace: ${preview.target}`,
        );
      }
      if (preview.inspectionErrors.length > 0) {
        throw new Error("Refusing to apply an incomplete workspace inspection.");
      }
      if (preview.ownerRepairs.length === 0) {
        writeLine("No CodexSandboxOffline-owned objects require repair.");
        return;
      }
      writeLine(
        `Requesting Windows UAC elevation to change only ${String(preview.ownerRepairs.length)} owner record(s)...`,
      );
      const result = await workspaceRepairService.apply(preview);
      if (result.after.ownerRepairs.length > 0 || result.after.inspectionErrors.length > 0) {
        writeLine(
          `Repair incomplete: ${String(result.after.ownerRepairs.length)} owner record(s) remain.`,
        );
        setExitCode(2);
        return;
      }
      writeLine(`Backup manifest: ${result.manifestPath}`);
      writeLine(
        `Workspace ownership repair completed for ${result.after.target}. Existing DACL and inheritance settings were preserved.`,
      );
    });

  sandbox.action(() => sandbox.outputHelp());
  return sandbox;
}

function writeWorkspaceRepairPreview(
  writeLine: (value: string) => void,
  preview: WindowsWorkspaceRepairPreview,
): void {
  writeLine(`Workspace ownership repair target: ${preview.target}`);
  writeLine(`Replacement owner: ${preview.currentOwner}`);
  writeLine(`Scanned items: ${String(preview.scannedItems)}`);
  writeLine(
    `CodexSandboxOffline-owned items: ${String(preview.ownerRepairs.length)}`,
  );
  for (const item of preview.ownerRepairs.slice(0, 20)) {
    writeLine(
      `  OWNER ${item.owner} -> ${preview.currentOwner}: ${item.path}` +
        ` (inheritance=${item.inheritanceProtected ? "protected" : "enabled"}, unchanged)`,
    );
  }
  if (preview.ownerRepairs.length > 20) {
    writeLine(`  ... ${String(preview.ownerRepairs.length - 20)} more owner change(s)`);
  }
  writeLine(`Skipped reparse points: ${String(preview.skippedReparsePoints.length)}`);
  for (const error of preview.inspectionErrors.slice(0, 10)) {
    writeLine(`Inspection error: ${error}`);
  }
}
