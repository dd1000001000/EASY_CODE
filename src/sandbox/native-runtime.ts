import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveEasyCodePaths } from "../config/defaults.js";

export const NATIVE_SANDBOX_RUNTIME_PACKAGE = "@openai/codex";
export const NATIVE_SANDBOX_BOOTSTRAP_VERSION = "0.153.4";

const WINDOWS_BOOTSTRAP_PACKAGES: Readonly<Record<string, string>> = {
  x64: "easy-code-codex-bootstrap-win32-x64",
  arm64: "easy-code-codex-bootstrap-win32-arm64",
};

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

/**
 * Return the Windows-only compatibility runtime used to provision a brand-new
 * elevated sandbox when a known-broken current runtime cannot lock its initial
 * `.sandbox-bin` directory. Normal commands always use the current runtime.
 */
export function nativeSandboxBootstrapEntrypoint(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  if (platform !== "win32") {
    throw new Error("The native sandbox bootstrap runtime is Windows-only");
  }
  const packageName = WINDOWS_BOOTSTRAP_PACKAGES[architecture];
  if (!packageName) {
    throw new Error(`No Windows sandbox bootstrap runtime is available for ${architecture}`);
  }
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
  const target = nativeSandboxTarget(platform, architecture);
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

function validatedLocalProxyURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !/^\d+$/u.test(url.port) ||
      Number(url.port) < 1024 || Number(url.port) > 65535 || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Native sandbox proxy must be an authenticated or unauthenticated HTTP URL on 127.0.0.1 with an explicit unprivileged port");
  }
  return url.href;
}

function validatedProxyPorts(values: readonly number[]): number[] {
  const ports = [...new Set(values)];
  if (ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || ports.length > 128) {
    throw new Error("Native sandbox proxy port list contains an invalid port");
  }
  return ports.sort((a, b) => a - b);
}

export function nativeSandboxProxyEnvironment(
  localProxyURL?: string,
  windowsProxyPorts: readonly number[] = [],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  if (localProxyURL) {
    const proxy = validatedLocalProxyURL(localProxyURL);
    environment.HTTP_PROXY = proxy;
    environment.HTTPS_PROXY = proxy;
    environment.ALL_PROXY = proxy;
    environment.NO_PROXY = "127.0.0.1,localhost";
  }
  const ports = validatedProxyPorts(windowsProxyPorts);
  if (ports.length) environment.CODEX_WINDOWS_SANDBOX_PROXY_PORTS = ports.join(",");
  return environment;
}

export function nativeSandboxEnvironment(
  home: string,
  source: NodeJS.ProcessEnv = process.env,
  localProxyURL?: string,
  windowsProxyPorts: readonly number[] = [],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "TMPDIR", "HOME", "PATH", "PATHEXT", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  // This variable is private to the child process. EASY CODE never changes the
  // controller's CODEX_HOME or reads a user's Codex configuration.
  environment.CODEX_HOME = home;
  environment.NO_COLOR = "1";
  Object.assign(environment, nativeSandboxProxyEnvironment(localProxyURL, windowsProxyPorts));
  return environment;
}
