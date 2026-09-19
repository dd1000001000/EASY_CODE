import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface AuthorizationOpenCommand {
  readonly program: string;
  readonly args: readonly string[];
}

/** Open only a web authorization URL, never a shell command or arbitrary URI scheme. */
export function authorizationOpenCommand(
  value: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot = process.env.SystemRoot ?? "C:\\Windows",
): AuthorizationOpenCommand {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("MCP authorization links must use HTTPS or loopback HTTP");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("MCP authorization links must not contain credentials or fragments");
  }
  if (platform === "win32") return {
    program: path.win32.join(systemRoot, "System32", "rundll32.exe"),
    args: ["url.dll,FileProtocolHandler", url.toString()],
  };
  if (platform === "darwin") return { program: "/usr/bin/open", args: [url.toString()] };
  if (platform === "linux") return { program: "/usr/bin/xdg-open", args: [url.toString()] };
  throw new Error(`Automatic browser opening is unavailable on ${platform}`);
}

export async function openAuthorizationUrl(url: string): Promise<void> {
  const command = authorizationOpenCommand(url);
  if (!existsSync(command.program)) throw new Error(`Browser opener is unavailable: ${command.program}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.program, [...command.args], {
      detached: true, stdio: "ignore", windowsHide: true, shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
