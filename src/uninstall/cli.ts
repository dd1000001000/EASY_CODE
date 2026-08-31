import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import type { Command } from "commander";

import { cleanupEasyCodeUserData } from "./cleanup.js";

const PACKAGE_NAME = "easy-code-agent";

export interface PackageRemovalInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export function resolveNpmRemovalInvocation(
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
  platform = process.platform,
): PackageRemovalInvocation {
  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath && existsSync(npmExecPath)) {
    return {
      command: execPath,
      args: [npmExecPath, "uninstall", "--global", PACKAGE_NAME],
      shell: false,
    };
  }

  const executableDirectory = path.dirname(execPath);
  const npmCliCandidates = [
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCli = npmCliCandidates.find((candidate) => existsSync(candidate));
  if (npmCli) {
    return {
      command: execPath,
      args: [npmCli, "uninstall", "--global", PACKAGE_NAME],
      shell: false,
    };
  }

  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: ["uninstall", "--global", PACKAGE_NAME],
    // Windows batch launchers require a command shell. All values are fixed
    // product constants; no user-controlled text is interpolated here.
    shell: platform === "win32",
  };
}

export async function removeGlobalEasyCodePackage(
  invocation = resolveNpmRemovalInvocation(),
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      stdio: "inherit",
      shell: invocation.shell,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `npm uninstall was terminated by ${signal}`
            : `npm uninstall exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall")
    .description("delete EASY CODE prompts and memories, then uninstall the global CLI")
    .option("--data-only", "delete prompts and memories without removing the npm package")
    .action(async (options: { dataOnly?: boolean }) => {
      const result = await cleanupEasyCodeUserData();
      process.stdout.write(
        `EASY CODE: removed ${result.removed.length} prompt/memory path(s) for the current OS user.\n`,
      );
      for (const warning of result.warnings) {
        process.stderr.write(`EASY CODE uninstall warning: ${warning}\n`);
      }
      process.stdout.write(
        "EASY CODE: API keys, configuration, caches, workspace files, and managed Worktrees were preserved.\n",
      );
      if (options.dataOnly) return;
      await removeGlobalEasyCodePackage();
    });
}
