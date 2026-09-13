import { sha256 } from "../utils/hash.js";
import type { ResolvedCommand } from "./types.js";
const TAG = "podman:v1:";
interface PodmanGrant { image: string; program: string; cwd: string; prefix: string[]; exact: boolean; network: boolean }
export const isPodmanGrant = (value: string) => value.startsWith(TAG);
export function decodePodmanGrant(value: string): PodmanGrant {
  const v = JSON.parse(Buffer.from(value.slice(TAG.length), "base64url").toString("utf8")) as PodmanGrant;
  if (!isPodmanGrant(value) || !v || Object.keys(v).sort().join() !== "cwd,exact,image,network,prefix,program" ||
      !/^[a-f0-9]{64}$/u.test(v.image) || typeof v.program !== "string" || !v.program || /[\0\r\n]/u.test(v.program) ||
      typeof v.cwd !== "string" || !v.cwd.startsWith("/") || typeof v.exact !== "boolean" || typeof v.network !== "boolean" ||
      !Array.isArray(v.prefix) || v.prefix.length !== 1 || typeof v.prefix[0] !== "string" ||
      !(v.exact ? /^[a-f0-9]{64}$/u : /^[a-z][a-z0-9_-]{0,48}$/u).test(v.prefix[0])) throw new Error("Invalid Podman permission prefix");
  return v;
}
export function podmanCommandGrant(command: ResolvedCommand, image: string, network: boolean): string {
  const safePrefix = ["git", "pip", "pip3", "npm", "cargo", "go", "apt", "apt-get"].includes(command.program) &&
    /^[a-z][a-z0-9_-]{0,48}$/u.test(command.args[0] ?? "");
  return TAG + Buffer.from(JSON.stringify({ image, program: command.program, cwd: command.cwdAbsolute,
    prefix: [safePrefix ? command.args[0]! : sha256(JSON.stringify(command.args))], exact: !safePrefix, network })).toString("base64url");
}
export function podmanGrantMatches(a: string, b: string): boolean {
  const x = decodePodmanGrant(a), y = decodePodmanGrant(b);
  return x.image === y.image && x.program === y.program && x.cwd === y.cwd && x.exact === y.exact &&
    x.prefix[0] === y.prefix[0] && (x.network || !y.network);
}
