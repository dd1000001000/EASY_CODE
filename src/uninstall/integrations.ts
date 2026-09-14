import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertPlainAncestors } from "../install/ownership.js";
import { addPath, children, identity, readJson, type UninstallPlan } from "./plan.js";
import { checked, runSystem, type SystemRunner } from "./system.js";

const require = createRequire(import.meta.url);
export const EXTENSION_ID = "dd1000001000.easy-code-image-paste";
export function packageRoot(): string { return fileURLToPath(new URL("../../", import.meta.url)); }
export async function addCredentials(plan: UninstallPlan, remove?: (slot: string) => Promise<void>): Promise<void> {
  const slots = new Set<string>();
  for (const record of plan.resources) if (record.kind === "credential" && record.name) slots.add(record.name);
  for (const slot of slots) {
    if (!/^[a-z][a-z0-9-]{0,63}\.api-key$/u.test(slot)) { plan.blockers.push("Invalid credential identifier"); continue; }
    plan.actions.push({ id: "credential:" + slot, phase: 50, target: "keyring:easy-code-agent/" + slot, description: "Delete EASY CODE's stored API key (if present)",
      execute: async () => {
        if (remove) return remove(slot);
        const { AsyncEntry } = require("@napi-rs/keyring");
        try { await new AsyncEntry("easy-code-agent", slot).deleteCredential(); }
        catch { throw new Error("Cannot remove credential " + slot + "; unlock the system credential store. No key value was read."); }
      } });
  }
}
export async function addExtensions(plan: UninstallPlan, integration?: { programs: string[]; run: (program: string, args: string[]) => { status: number | null; stdout?: string; stderr?: string } }): Promise<void> {
  const helper: { programs: string[]; run: (program: string, args: string[]) => { status: number | null; stdout?: string; stderr?: string } } = integration ?? (() => {
    const module = require(path.join(packageRoot(), "scripts", "install-vscode-extension.cjs"));
    return { programs: module.findVsCodeClis(), run: (program: string, args: string[]) => module.runVsCodeCli(program, args) };
  })();
  const registeredPrograms = new Set(plan.resources
    .filter(record => record.kind === "extension" && record.name === EXTENSION_ID && record.path)
    .map(record => record.path!));
  for (const program of helper.programs.filter(candidate => registeredPrograms.has(candidate))) {
    const listed = helper.run(program, ["--list-extensions"]);
    if (listed.status !== 0) { plan.blockers.push("Cannot inspect VS Code extensions via " + program); continue; }
    if (!String(listed.stdout ?? "").split(/\r?\n/u).some(line => line.trim().toLowerCase() === EXTENSION_ID)) continue;
    plan.actions.push({ id: "extension:" + program, phase: 45, target: EXTENSION_ID + " via " + program, description: "Uninstall EASY CODE terminal integration",
      execute: async () => {
        const removed = helper.run(program, ["--uninstall-extension", EXTENSION_ID]);
        if (removed.status !== 0) throw new Error("VS Code extension removal failed: " + program);
        const after = helper.run(program, ["--list-extensions"]);
        if (after.status !== 0 || String(after.stdout ?? "").split(/\r?\n/u).includes(EXTENSION_ID)) throw new Error("VS Code extension removal not confirmed");
      } });
  }
  if (registeredPrograms.size > 0 && !helper.programs.length) {
    for (const folder of [".vscode", ".vscode-insiders"]) {
      const entries = await children(path.join(plan.home, folder, "extensions"));
      if (entries.some(n => n.startsWith(EXTENSION_ID + "-"))) plan.blockers.push("VS Code CLI unavailable but its EASY CODE extension remains in " + folder);
    }
  }
  const appData = process.platform === "win32" ? path.join(plan.home, "AppData", "Roaming")
    : process.platform === "darwin" ? path.join(plan.home, "Library", "Application Support") : path.join(plan.home, ".config");
  if (registeredPrograms.size > 0) {
    for (const name of ["Code", "Code - Insiders"])
      await addPath(plan, path.join(appData, name, "User", "globalStorage", EXTENSION_ID), 46);
  }
}
export interface NpmInvocation { command: string; args: readonly string[]; shell: boolean }
export async function addPackage(plan: UninstallPlan, invocation: NpmInvocation, remove: (invocation: NpmInvocation) => Promise<void>,
  run: SystemRunner = runSystem, expectedRoot = packageRoot()): Promise<void> {
  // Resolve the current npm installation first. No filesystem recursion into a linked checkout.
  const prefixArgs = invocation.args.slice(0, invocation.args.indexOf("uninstall"));
  try {
    const root = await checked(run, invocation.command, [...prefixArgs, "root", "--global"]);
    const prefix = await checked(run, invocation.command, [...prefixArgs, "prefix", "--global"]);
    if (!path.isAbsolute(root) || !path.isAbsolute(prefix)) throw new Error("npm returned a non-absolute installation path");
    const installed = path.join(root, "easy-code-agent");
    if (!existsSync(installed)) { plan.warnings.push("No global EASY CODE package in this npm prefix; source checkout will be preserved."); return; }
    const resolved = realpathSync.native(installed);
    if (identity(resolved) !== identity(realpathSync.native(expectedRoot))) throw new Error("Current npm prefix owns a different EASY CODE installation; uninstall from its owning npm.");
    const metadata = await readJson(path.join(resolved, "package.json"));
    if (metadata.name !== "easy-code-agent") throw new Error("Unexpected global package identity");
    plan.actions.push({ id: "npm:" + prefix, phase: 100, target: installed, description: "Uninstall global CLI and launchers; preserve a linked source checkout",
      execute: async () => {
        if (!existsSync(installed)) return;
        if (identity(realpathSync.native(installed)) !== identity(resolved)) throw new Error("npm installation changed after preview");
        await remove({ ...invocation, args: [...prefixArgs, "uninstall", "--global", "--prefix", prefix, "--ignore-scripts", "easy-code-agent"] });
        if (existsSync(installed)) throw new Error("npm package removal not confirmed");
      } });
  } catch (error) { plan.blockers.push("Package inventory: " + String(error)); }
}
