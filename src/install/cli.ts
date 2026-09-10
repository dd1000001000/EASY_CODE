import type { Command } from "commander";

import { inspectInstallPaths } from "./diagnostics.js";

function printLocations(label: string, locations: Array<{ directory: string; launchers: string[] }>): void {
  process.stdout.write(`${label}:\n`);
  if (locations.length === 0) {
    process.stdout.write("- not found on PATH\n");
    return;
  }
  for (const location of locations) process.stdout.write(`- ${location.directory}\n`);
}

/** Register diagnostics that remain usable after a partially blocked npm install. */
export function registerInstallCommands(program: Command): Command {
  const install = program
    .command("install")
    .description("diagnose EASY CODE source and global installation paths");

  install
    .command("doctor")
    .description("find conflicting npm and easy-code launchers on PATH")
    .action(() => {
      const diagnostics = inspectInstallPaths();
      process.stdout.write(`Node: ${diagnostics.nodeExecutable}\n`);
      printLocations("npm launcher directories", diagnostics.npm);
      printLocations("easy-code launcher directories", diagnostics.easyCode);

      if (diagnostics.multipleNpmLocations) {
        process.stderr.write(
          "WARN Multiple npm installations are visible on PATH; use one explicit npm executable for global installs.\n",
        );
      }
      if (diagnostics.conflictingEasyCodeLocations) {
        process.stderr.write(
          "FAIL Multiple easy-code global launcher directories are visible. Uninstall easy-code-agent with each owning npm before reinstalling; do not use --force.\n",
        );
        process.exitCode = 2;
        return;
      }
      process.stdout.write("EASY CODE installation paths are consistent.\n");
    });

  install.action(() => install.outputHelp());
  return install;
}
