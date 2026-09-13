import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { assertPlainAncestors } from "../install/ownership.js";

import type { Command } from "commander";

import { buildFilePlan, type UninstallAction, type UninstallPlan } from "./plan.js";
import { addPodman } from "./podman.js";
import { addWorktrees } from "./worktrees.js";
import { addCredentials, addExtensions, addPackage } from "./integrations.js";
import { activeOwners, executeUninstall } from "./execute.js";

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

export interface UninstallOptions { dryRun?: boolean; yes?: boolean; keepCli?: boolean }
export async function createUninstallPlan(options: UninstallOptions = {}): Promise<UninstallPlan> {
  const plan = await buildFilePlan();
  for (const inspect of [addPodman, addWorktrees, addCredentials, addExtensions]) {
    try { await inspect(plan); } catch (error) { plan.blockers.push(String(error)); }
  }
  // Include unreadable legacy leases in the scope of the single confirmation.
  // Independent runtime/command ownership checks still apply during execution.
  for (const root of plan.roots.data) {
    const file = path.join(root, "easy-code.db");
    if (!existsSync(file)) continue;
    let db;
    try {
      assertPlainAncestors(file);
      const { Database } = createRequire(import.meta.url)("node-sqlite3-wasm");
      db = new Database(file, { readOnly: true, fileMustExist: true });
      db.get("SELECT name FROM sqlite_master LIMIT 1");
    } catch {
      plan.actions.push({ id: "corrupt-store:" + file, phase: 5, target: file,
        description: "Remove corrupt store with unverifiable legacy leases (close all sessions first)",
        confirmation: "corrupt-store:" + file, execute: async () => {} });
    } finally { db?.close(); }
  }
  if (!options.keepCli) await addPackage(plan, resolveNpmRemovalInvocation(), removeGlobalEasyCodePackage);
  return plan;
}
export interface UninstallDependencies {
  prepare: typeof createUninstallPlan;
  owners: typeof activeOwners;
  execute: typeof executeUninstall;
  interactive: boolean;
  write: (message: string) => void;
  question: (message: string) => Promise<string>;
}
function actionGroup(action: UninstallAction): string {
  if (action.phase < 10) return "Data, configuration, history and caches";
  if (action.phase < 30) return "Dedicated sandbox and owned container resources";
  if (action.phase < 40) return "Managed Worktrees and Runtime refs";
  if (action.phase <= 50) return "Terminal integration and stored API keys";
  if (action.phase <= 80) return "Data, configuration, history and caches";
  if (action.phase < 100) return "Podman installed exclusively by EASY CODE";
  return "Global CLI and launchers";
}
export async function runUninstall(options: UninstallOptions, overrides: Partial<UninstallDependencies> = {}): Promise<void> {
  const io: UninstallDependencies = {
    prepare: createUninstallPlan, owners: activeOwners, execute: executeUninstall,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: message => process.stdout.write(message + "\n"),
    question: async message => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { return await prompt.question(message); } finally { prompt.close(); }
    }, ...overrides,
  };
  const plan = await io.prepare(options);
  const actions = [...plan.actions].sort((a, b) => a.phase - b.phase);
  io.write("EASY CODE full uninstall (current OS user)");
  if (options.dryRun) {
    for (const item of actions) io.write("- " + item.description + ": " + item.target);
  } else {
    for (const group of new Set(actions.map(actionGroup))) io.write("- " + group);
    io.write("One confirmation removes all verified items, including legacy sandbox data and unintegrated managed Worktrees. No undo without a backup.");
    io.write("User projects, linked source checkouts, shared software and unidentified resources are preserved. Details: easy-code uninstall --dry-run");
    if (actions.some(item => item.id.startsWith("corrupt-store:")))
      io.write("Some stores are unreadable. Close all other EASY CODE sessions before confirming their removal.");
  }
  for (const warning of plan.warnings) io.write("Preserved/notice: " + warning);
  for (const blocker of plan.blockers) io.write("BLOCKED: " + blocker);
  const owners = await io.owners(plan).catch(error => [String(error)]);
  for (const owner of owners) io.write("Active/unknown: " + owner);
  if (options.dryRun) { if (plan.blockers.length) process.exitCode = 2; return; }
  if (plan.blockers.length) throw new Error("Uninstall preflight failed. Nothing was removed.");
  if (!options.yes) {
    if (!io.interactive) throw new Error("Non-interactive uninstall requires --yes after reviewing --dry-run.");
    const answer = await io.question("Permanently uninstall EASY CODE and all included data/resources? [y/N] ");
    if (!/^y(?:es)?$/iu.test(answer.trim())) { io.write("Cancelled. Nothing was removed."); return; }
  }
  // The one global consent covers every flagged item in this exact preview.
  // It does not bypass ownership checks, stale-plan checks or active owners.
  const confirmations = [...new Set(actions.flatMap(item => item.confirmation ? [item.confirmation] : []))];
  const reported = new Set<string>();
  await io.execute(plan, { confirmations, log: io.write, onAction: item => {
    const group = actionGroup(item);
    if (!reported.has(group)) { reported.add(group); io.write("Removing: " + group); }
  } });
}
export function registerUninstallCommand(program: Command): void {
  program.command("uninstall")
    .description("fully uninstall current-user EASY CODE data, credentials, integration, owned sandbox and global CLI")
    .option("--dry-run", "inspect and print the removal plan without changing anything")
    .option("--yes", "confirm the entire verified removal plan without interactive prompts")
    .option("--keep-cli", "remove owned user resources but keep the npm CLI")
    .action((options: UninstallOptions) => runUninstall(options));
}
