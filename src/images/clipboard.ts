import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MAX_IMAGE_BYTES } from "./image-store.js";
import { hostPlatform } from "../core/host-platform.js";
import type { ClipboardExecutionContext, ClipboardPlatformHost, ClipboardPlatformReader } from "./clipboard-platform.js";
import { windowsClipboard } from "./platform/windows.js";
import { macosClipboard } from "./platform/macos.js";
import { linuxClipboard } from "./platform/linux.js";

export interface ClipboardImageReader {
  readImage(signal?: AbortSignal): Promise<Buffer>;
  /** Optional text fallback for ambiguous native paste key sequences. */
  readText?(signal?: AbortSignal): Promise<string | undefined>;
}

export interface ClipboardCommandOptions {
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export type ClipboardCommandRunner = (
  program: string,
  args: readonly string[],
  options: ClipboardCommandOptions,
) => Promise<Buffer>;

export interface SystemClipboardImageReaderOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly runCommand?: ClipboardCommandRunner;
  readonly timeoutMs?: number;
  /** Used only to reject helper executables resolved from the active workspace. */
  readonly currentDirectory?: string;
}

class ClipboardCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ClipboardCommandError";
  }
}

export class SystemClipboardImageReader implements ClipboardImageReader, ClipboardPlatformHost {
  private readonly platform: NodeJS.Platform;
  readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly runCommand: ClipboardCommandRunner;
  private readonly timeoutMs: number;
  private readonly currentDirectory: string;
  private readonly verifyPrograms: boolean;
  private readonly backend: ClipboardPlatformReader;

  constructor(options: SystemClipboardImageReaderOptions = {}) {
    this.platform = hostPlatform(options.platform);
    this.sourceEnv = options.env ?? process.env;
    this.runCommand = options.runCommand ?? runClipboardCommand;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.currentDirectory = path.resolve(options.currentDirectory ?? process.cwd());
    this.verifyPrograms = options.runCommand === undefined;
    switch (this.platform) {
      case "win32": this.backend = windowsClipboard(this); break;
      case "darwin": this.backend = macosClipboard(this); break;
      case "linux": this.backend = linuxClipboard(this); break;
      default: throw new Error(`Image clipboard paste is not supported on ${this.platform}.`);
    }
  }

  async readImage(signal?: AbortSignal): Promise<Buffer> {
    throwIfAborted(signal);
    const privateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "easy-code-clipboard-"),
    );
    const execution: ClipboardExecutionContext = {
      cwd: privateDirectory,
      env: createClipboardEnvironment(
        this.platform,
        this.sourceEnv,
        privateDirectory,
        this.currentDirectory,
      ),
      signal,
    };
    try {
      const data = await this.backend.readImage(execution);
      if (!data.length) throw new Error("The clipboard does not contain an image.");
      if (data.length > MAX_IMAGE_BYTES) {
        throw new Error("The clipboard image exceeds the 10 MiB size limit.");
      }
      return data;
    } finally {
      await rm(privateDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async readText(signal?: AbortSignal): Promise<string | undefined> {
    throwIfAborted(signal);
    const privateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "easy-code-clipboard-"),
    );
    const execution: ClipboardExecutionContext = {
      cwd: privateDirectory,
      env: createClipboardEnvironment(
        this.platform,
        this.sourceEnv,
        privateDirectory,
        this.currentDirectory,
      ),
      signal,
    };
    try {
      const data = await this.backend.readText(execution);
      const text = data.toString("utf8").replace(/^\uFEFF/u, "");
      return text || undefined;
    } finally {
      await rm(privateDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  run(program: string, args: readonly string[], maxOutputBytes: number, execution: ClipboardExecutionContext): Promise<Buffer> {
    return this.runCommand(program, args, this.commandOptions(maxOutputBytes, execution));
  }

  windowsRoot(): string { return getWindowsRoot(this.sourceEnv); }

  readTemporaryFile(file: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    return readTemporaryClipboardFile(file, maxBytes, signal);
  }

  private commandOptions(maxOutputBytes: number, execution: ClipboardExecutionContext): ClipboardCommandOptions {
    return { maxOutputBytes, timeoutMs: this.timeoutMs, cwd: execution.cwd, env: execution.env, signal: execution.signal };
  }

  async resolveUnixHelper(name: "wl-paste" | "xclip"): Promise<string> {
    const directories = secureUnixPathDirectories(this.sourceEnv.PATH, this.currentDirectory);
    const candidates = directories.length ? directories : ["/usr/bin", "/bin"];
    if (!this.verifyPrograms) return path.posix.join(candidates[0] ?? "/usr/bin", name);
    const canonicalCurrentDirectory = await realpath(this.currentDirectory).catch(() => this.currentDirectory);
    const failures: string[] = [];
    for (const directory of candidates) {
      try {
        const canonicalDirectory = await realpath(directory);
        if (isPathInside(canonicalDirectory, canonicalCurrentDirectory)) continue;
        const candidate = path.posix.join(directory, name);
        const canonical = await realpath(candidate);
        if (!isPathInside(canonical, canonicalDirectory)) continue;
        if (isPathInside(canonical, canonicalCurrentDirectory)) continue;
        await verifyExecutable(canonical);
        return canonical;
      } catch (error) { failures.push(errorMessage(error)); }
    }
    throw new ClipboardCommandError(
      `${name} was not found in a trusted absolute PATH directory. ${failures.at(-1) ?? ""}`, "ENOENT");
  }

  async resolveFixedProgram(program: string, platform: "win32" | "linux" | "darwin"): Promise<string> {
    if (!isAbsoluteForPlatform(program, platform)) {
      throw new ClipboardCommandError("Clipboard helper path must be absolute.");
    }
    if (!this.verifyPrograms) return program;
    const canonical = await realpath(program);
    if (isPathInside(canonical, this.currentDirectory)) {
      throw new ClipboardCommandError("Refusing to execute a clipboard helper from the workspace.");
    }
    await verifyExecutable(canonical);
    return canonical;
  }
}

export { chooseClipboardMediaType, chooseClipboardTextType } from "./clipboard-media.js";

export function createClipboardEnvironment(
  platform: NodeJS.Platform,
  source: NodeJS.ProcessEnv,
  privateDirectory: string,
  rejectedRoot = process.cwd(),
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  const names = platform === "win32"
    ? ["SystemRoot", "WINDIR", "ComSpec", "LANG", "LC_ALL"]
    : [
        "HOME",
        "LANG",
        "LC_ALL",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "WSL_DISTRO_NAME",
        "WSL_INTEROP",
      ];
  for (const name of names) {
    const value = getEnvironmentValue(source, name);
    if (value !== undefined) output[name] = value;
  }
  if (platform === "win32") {
    output.TEMP = privateDirectory;
    output.TMP = privateDirectory;
    const root = getWindowsRoot(source);
    output.PATH = [path.win32.join(root, "System32"), root].join(";");
  } else {
    output.TMPDIR = privateDirectory;
    output.TMP = privateDirectory;
    output.TEMP = privateDirectory;
    const directories = secureUnixPathDirectories(source.PATH, rejectedRoot);
    output.PATH = directories.join(":") || "/usr/bin:/bin";
  }
  return output;
}

export async function runClipboardCommand(
  program: string,
  args: readonly string[],
  options: ClipboardCommandOptions,
): Promise<Buffer> {
  throwIfAborted(options.signal);
  if (!isAbsoluteForPlatform(program, process.platform)) {
    throw new ClipboardCommandError("Clipboard helper path must be absolute.");
  }
  if (!path.isAbsolute(options.cwd)) {
    throw new ClipboardCommandError("Clipboard helper working directory must be absolute.");
  }
  const cwdInfo = await lstat(options.cwd);
  if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory()) {
    throw new ClipboardCommandError("Clipboard helper working directory is unsafe.");
  }
  return new Promise((resolve, reject) => {
    let stdoutLength = 0;
    let stderr = "";
    let settled = false;
    let terminationError: Error | undefined;
    const stdout: Buffer[] = [];
    const child = spawn(program, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      terminate(createAbortError());
    };

    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };
    const terminate = (error: Error): void => {
      if (settled || terminationError) return;
      terminationError = error;
      if (timer) clearTimeout(timer);
      try {
        child.kill();
      } catch {
        finish(error);
        return;
      }
      // Resolve cancellation only after the helper closes so its private cwd
      // can be removed reliably on Windows. Escalate if a Unix helper ignores
      // SIGTERM; Windows maps kill() to process termination directly.
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          finish(error);
          return;
        }
        killTimer = setTimeout(() => finish(error), 1_000);
        killTimer.unref?.();
      }, 500);
      killTimer.unref?.();
    };
    timer = setTimeout(() => {
      terminate(new ClipboardCommandError("Clipboard helper timed out.", "ETIMEDOUT"));
    }, options.timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutLength += chunk.length;
      if (stdoutLength > options.maxOutputBytes) {
        terminate(new ClipboardCommandError("Clipboard image exceeds the size limit."));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stderr.length < 4_096) stderr += chunk.toString("utf8");
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(terminationError ?? new ClipboardCommandError(error.message, error.code));
    });
    child.once("close", (code) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code !== 0) {
        const description = stderr.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
        finish(
          new ClipboardCommandError(
            description || `Clipboard helper exited with code ${code ?? "unknown"}.`,
          ),
        );
        return;
      }
      finish(undefined, Buffer.concat(stdout, stdoutLength));
    });
  });
}

function secureUnixPathDirectories(
  value: string | undefined,
  rejectedRoot: string,
): string[] {
  const entries = (value ?? "/usr/local/bin:/usr/bin:/bin")
    .split(":")
    .filter((entry) => path.posix.isAbsolute(entry));
  const unique = new Set<string>();
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry);
    if (isPathInside(normalized, rejectedRoot)) continue;
    unique.add(normalized);
  }
  return [...unique];
}

async function verifyExecutable(program: string): Promise<void> {
  const info = await stat(program);
  if (!info.isFile()) throw new ClipboardCommandError("Clipboard helper is not a regular file.");
  await access(program, fsConstants.X_OK);
}

async function readTemporaryClipboardFile(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Clipboard helper did not create a regular image file.");
  }
  if (info.size > maxBytes) throw new Error("The clipboard image exceeds the size limit.");
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== info.size || before.size > maxBytes) {
      throw new Error("Clipboard image changed before it could be read.");
    }
    const output = Buffer.allocUnsafe(before.size);
    let position = 0;
    while (position < output.length) {
      throwIfAborted(signal);
      const result = await handle.read(output, position, output.length - position, position);
      if (result.bytesRead === 0) throw new Error("Clipboard image was truncated.");
      position += result.bytesRead;
    }
    const extra = await handle.read(Buffer.allocUnsafe(1), 0, 1, output.length);
    const after = await handle.stat();
    if (
      extra.bytesRead !== 0 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("Clipboard image changed while it was being read.");
    }
    return output;
  } finally {
    await handle.close();
  }
}

function getWindowsRoot(environment: NodeJS.ProcessEnv): string {
  const configured = getEnvironmentValue(environment, "SystemRoot") ??
    getEnvironmentValue(environment, "WINDIR") ?? "C:\\Windows";
  if (!path.win32.isAbsolute(configured) || configured.includes("\0")) {
    throw new ClipboardCommandError("Windows system root is invalid.");
  }
  return path.win32.normalize(configured);
}

function getEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const exact = environment[name];
  if (exact !== undefined) return exact;
  const key = Object.keys(environment).find((candidate) =>
    candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? environment[key] : undefined;
}

function isAbsoluteForPlatform(
  value: string,
  platform: "win32" | "linux" | "darwin" | NodeJS.Platform,
): boolean {
  return platform === "win32" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

function isPathInside(candidate: string, root: string): boolean {
  const implementation = /^[A-Za-z]:[\\/]/u.test(candidate) || /^[A-Za-z]:[\\/]/u.test(root)
    ? path.win32
    : path.posix;
  const normalize = (value: string): string =>
    implementation === path.win32
      ? implementation.resolve(value).toLowerCase()
      : implementation.resolve(value);
  const relative = implementation.relative(normalize(root), normalize(candidate));
  return relative === "" ||
    (!relative.startsWith(`..${implementation.sep}`) &&
      relative !== ".." &&
      !implementation.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("Clipboard image capture was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
