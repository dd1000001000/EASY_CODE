import path from "node:path";
import type { ResolvedCommand } from "./types.js";
import { reusableExecutableGrant } from "./security.js";
import { sha256 } from "../utils/hash.js";

const TAG = "command:v2:";
export interface CommandGrant {
  executable: string; digest: string; args: string[]; cwd: string;
  scope: "workspace" | "host" | "container"; network: boolean;
  material: string; exact: boolean;
}
export function isCommandGrant(value: string): boolean { return value.startsWith(TAG); }
export function decodeCommandGrant(value: string): CommandGrant {
  const v = JSON.parse(Buffer.from(value.slice(TAG.length), "base64url").toString("utf8")) as CommandGrant;
  if (!isCommandGrant(value) || !v || Object.keys(v).sort().join() !== "args,cwd,digest,exact,executable,material,network,scope" ||
      typeof v.executable !== "string" || !path.isAbsolute(v.executable) || typeof v.cwd !== "string" ||
      !/^[a-f0-9]{64}$/u.test(v.digest) || typeof v.material !== "string" || !["workspace", "host", "container"].includes(v.scope) ||
      typeof v.network !== "boolean" || typeof v.exact !== "boolean" || !Array.isArray(v.args) || v.args.length > 256 ||
      v.args.some(a => typeof a !== "string" || a.includes("\0"))) throw new Error("Invalid command permission grant");
  return v;
}
export function commandGrantPrefix(command: ResolvedCommand, scope: CommandGrant["scope"], network: boolean): string {
  const narrow = reusableExecutableGrant(command.executablePath) && !command.executableInsideWorkspace;
  const exact = !narrow || !/^[a-z][a-z0-9_-]{0,48}$/u.test(command.args[0] ?? "");
  // Exact commands may contain inline code and secrets. Persist their identity,
  // not the raw arguments; the approval screen separately shows a redacted argv.
  const args = exact ? [sha256(JSON.stringify(command.args))] : [command.args[0]!];
  const grant: CommandGrant = { executable: command.executablePath, digest: command.executableHash!, args,
    cwd: scope === "workspace" ? command.cwdRelative : command.cwdAbsolute, scope, network,
    material: command.approvalMaterialHash ?? "", exact };
  return TAG + Buffer.from(JSON.stringify(grant)).toString("base64url");
}
export function commandGrantMatches(granted: string, candidate: string): boolean {
  const a = decodeCommandGrant(granted), b = decodeCommandGrant(candidate);
  return a.executable === b.executable && a.digest === b.digest && a.cwd === b.cwd && a.scope === b.scope &&
    (a.network || !b.network) && a.material === b.material &&
    a.exact === b.exact && a.args.length === b.args.length && a.args.every((arg, i) => arg === b.args[i]);
}
