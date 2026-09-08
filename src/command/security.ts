import path from "node:path";
import { realpathSync } from "node:fs";

/** Benchmark is a trusted environment profile, not an approval-mode override. */
export const BENCHMARK_COMMAND_NETWORK_POLICY = "deny-all" as const;

export function reusableExecutableGrant(filename: string): boolean {
  const name = filename.split(/[\\/]/u).pop()!.replace(/\.(?:exe|cmd|bat|com)$/iu, "").toLowerCase();
  return !/^python\d+(?:\.\d+)*$/u.test(name) && !new Set(["cmd", "powershell", "pwsh", "sh", "bash", "dash", "zsh", "fish",
    "node", "python", "python3", "perl", "ruby", "php", "npm", "npx", "pip", "pip3"]).has(name);
}

/** Only immutable-to-the-command tool locations may receive read-only recipes. */
export function trustedExecutableLocation(filename: string, workspaceRoot: string): boolean {
  const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const inside = (root: string, value: string) => {
    const relative = path.relative(key(root), key(value));
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  if (inside(workspaceRoot, filename)) return false;
  const roots = process.platform === "win32"
    ? [path.dirname(realpathSync.native(process.execPath)), process.env.ProgramFiles, process.env["ProgramFiles(x86)"],
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
    : ["/usr/bin", "/bin", "/usr/local/bin", path.dirname(realpathSync.native(process.execPath))];
  return roots.some((root) => root && inside(root, filename) && !inside(workspaceRoot, root));
}
