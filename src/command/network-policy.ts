import path from "node:path";
import type { ResolvedCommand } from "./types.js";

export type NetworkEffect = "read" | "download" | "upload" | "unknown";
export interface NetworkOperation {
  effect: NetworkEffect;
  /** Structured argv prefix, not a substring of the displayed command. */
  prefixArgs: string[];
  description: string;
}

const clients = new Set(["curl", "wget", "git", "gh", "npm", "npx", "pip", "pip3", "ssh", "scp", "sftp", "ftp", "rsync"]);
const basename = (value: string) => path.basename(value).replace(/\.(exe|cmd|bat|com)$/iu, "").toLowerCase();

/** Classification is deliberately conservative; model intent is not authority. */
export function inspectNetworkOperation(command: ResolvedCommand): NetworkOperation | undefined {
  let name = basename(command.executablePath);
  let args = command.args;
  let prefixArgs: string[] = [];
  if (/^python(?:\d+(?:\.\d+)*)?$/u.test(name) && args[0] === "-m" && args[1] === "pip") {
    name = "pip"; args = args.slice(2); prefixArgs = ["-m", "pip"];
  }
  if (!clients.has(name)) return undefined;
  const nonConfigArgs = args.filter(a => a !== "-q");
  if (nonConfigArgs.length === 1 && ["--version", "--help", "-h"].includes(nonConfigArgs[0]!)) return undefined;
  const op = (effect: NetworkEffect, prefix = prefixArgs): NetworkOperation => ({ effect, prefixArgs: prefix,
    description: `${name}: ${effect === "read" ? "read remote content" : effect === "download" ? "download files/dependencies" : effect === "upload" ? "send data or change remote state" : "network behavior is not statically known"}` });
  if (name === "curl") {
    // Only this small exact recipe can auto-approve. Unknown flags (including
    // config files, custom headers, bodies, auth, retries and URL expansion) ask.
    let effect: NetworkEffect = "read";
    let urls = 0;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (/^-[qsfSLIi]+$/u.test(a)) continue; // Common no-argument short flag bundles, e.g. -fsSL.
      if (["-q", "--disable", "-s", "--silent", "-S", "--show-error", "-sS", "-f", "--fail", "-L", "--location", "-I", "--head", "-i", "--include", "--compressed", "--globoff"].includes(a)) continue;
      if (["--max-time", "--connect-timeout", "-m"].includes(a) && /^\d+(?:\.\d+)?$/u.test(args[i + 1] ?? "")) { i++; continue; }
      if (["-o", "--output"].includes(a) && args[i + 1]) { effect = "download"; i++; continue; }
      if (["-O", "--remote-name"].includes(a)) { effect = "download"; continue; }
      if (/^(?:--data(?:-|=|$)|-d|--form(?:=|$)|-F|--upload-file(?:=|$)|-T)/u.test(a)) return op("upload");
      if (/^https?:\/\//iu.test(a)) {
        try { const u = new URL(a); if (u.username || u.password || /[{}[\]]/u.test(a)) return op("unknown"); } catch { return op("unknown"); }
        urls++; continue;
      }
      return op("unknown");
    }
    // A workspace shim named curl cannot obtain read-only authority.
    return op(urls === 1 && args[0] === "-q" && command.trustedExecutable === true && !command.executableInsideWorkspace ? effect : "unknown");
  }
  if (name === "wget") return op(args.some(a => /^--(?:post-data|post-file|body-data|body-file|method)(?:=|$)/u.test(a)) ? "upload" : "download");
  const sub = args[0];
  if (name === "git") {
    if (["fetch", "clone", "pull"].includes(sub ?? "")) return op("download", [sub!]);
    if (sub === "push" || sub === "send-email") return op("upload", [sub]);
    if (sub === "ls-remote") return op("unknown", [sub]); // URL rewrites/helpers may execute repository code.
    return sub?.startsWith("-") ? op("unknown") : undefined; // Options can change config/helpers; never auto-read.
  }
  if (name === "npm" || name === "pip" || name === "pip3") {
    if (["install", "i", "add", "ci", "download"].includes(sub ?? "")) return op("download", [...prefixArgs, sub!]);
    if (["publish", "unpublish", "deprecate"].includes(sub ?? "")) return op("upload", [...prefixArgs, sub!]);
    if (["view", "info", "search", "index"].includes(sub ?? "")) return op("unknown", [...prefixArgs, sub!]);
    return undefined;
  }
  return op("unknown");
}
