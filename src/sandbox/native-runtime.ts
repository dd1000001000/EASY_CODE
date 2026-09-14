import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveEasyCodePaths } from "../config/defaults.js";

export const NATIVE_SANDBOX_RUNTIME_PACKAGE = "@openai/codex";

export interface NativeSandboxTarget {
  packageName: string;
  targetTriple: string;
  binaryName: string;
}

export function nativeSandboxTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): NativeSandboxTarget {
  const key = `${platform}/${architecture}`;
  const targets: Readonly<Record<string, NativeSandboxTarget>> = {
    "win32/x64": { packageName: "@openai/codex-win32-x64", targetTriple: "x86_64-pc-windows-msvc", binaryName: "codex.exe" },
    "win32/arm64": { packageName: "@openai/codex-win32-arm64", targetTriple: "aarch64-pc-windows-msvc", binaryName: "codex.exe" },
    "darwin/x64": { packageName: "@openai/codex-darwin-x64", targetTriple: "x86_64-apple-darwin", binaryName: "codex" },
    "darwin/arm64": { packageName: "@openai/codex-darwin-arm64", targetTriple: "aarch64-apple-darwin", binaryName: "codex" },
    "linux/x64": { packageName: "@openai/codex-linux-x64", targetTriple: "x86_64-unknown-linux-musl", binaryName: "codex" },
    "linux/arm64": { packageName: "@openai/codex-linux-arm64", targetTriple: "aarch64-unknown-linux-musl", binaryName: "codex" },
  };
  const target = targets[key];
  if (!target) throw new Error(`Unsupported native sandbox platform: ${key}`);
  return target;
}

export function nativeSandboxEntrypoint(): string {
  const require = createRequire(import.meta.url);
  const target = nativeSandboxTarget();
  const packageRoot = path.dirname(require.resolve(`${target.packageName}/package.json`));
  return path.join(packageRoot, "vendor", target.targetTriple, "bin", target.binaryName);
}

/** Return the version npm actually installed for this EASY CODE installation.
 * The dependency is declared as `latest`; keeping the resolved value out of
 * source avoids silently reporting a stale, hard-coded sandbox version. */
export function nativeSandboxRuntimeVersion(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve(`${NATIVE_SANDBOX_RUNTIME_PACKAGE}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error(`Installed ${NATIVE_SANDBOX_RUNTIME_PACKAGE} package has no valid version`);
  }
  return manifest.version;
}

export function nativeSandboxHome(dataDir = resolveEasyCodePaths().dataDir): string {
  return path.join(dataDir, "native-sandbox", "runtime-home");
}

export function nativeSandboxWorker(): string {
  return fileURLToPath(new URL("native-worker.js", import.meta.url));
}

export function nativeSandboxEnvironment(home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "TMPDIR", "HOME", "PATH", "PATHEXT", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  // This variable is private to the child process. EASY CODE never changes the
  // controller's CODEX_HOME or reads a user's Codex configuration.
  environment.CODEX_HOME = home;
  environment.NO_COLOR = "1";
  return environment;
}
