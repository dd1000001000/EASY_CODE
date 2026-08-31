import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { VENDORED_SRT_WIN_EXE } from "@anthropic-ai/sandbox-runtime";
import { execa } from "execa";

const WINDOWS_READ_PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_READ_PROBE_INPUT = "EASY_CODE_SRT_READ_PROBE";

export type WindowsSandboxReadStatus = "readable" | "denied" | "unknown";

export interface WindowsSandboxReadProbe {
  /**
   * Returns a three-state result from the unmodified restricted SRT account.
   * Only an explicit access-denied result proves that a deny stamp is
   * redundant; missing files and ordinary I/O failures remain unknown.
   */
  pathAccess(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, WindowsSandboxReadStatus>>;
}

function normalizedKey(value: string): string {
  return path.win32.resolve(value).toLowerCase();
}

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

const READ_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$encoded = [Environment]::GetEnvironmentVariable('EASY_CODE_SRT_READ_PROBE')
$paths = @(([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json))
$results = [Collections.Generic.List[object]]::new()
foreach ($requestedPath in $paths) {
  $status = 'unknown'
  try {
    $item = Get-Item -LiteralPath ([string]$requestedPath) -Force -ErrorAction Stop
    if ($item.PSIsContainer) {
      $enumerator = [IO.Directory]::EnumerateFileSystemEntries($item.FullName).GetEnumerator()
      try {
        [void]$enumerator.MoveNext()
        $status = 'readable'
      } finally {
        if ($enumerator -is [IDisposable]) { $enumerator.Dispose() }
      }
    } else {
      $stream = [IO.File]::Open(
        $item.FullName,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
      )
      try { $status = 'readable' } finally { $stream.Dispose() }
    }
  } catch [UnauthorizedAccessException] {
    $status = 'denied'
  } catch [Security.SecurityException] {
    $status = 'denied'
  } catch {
    $status = 'unknown'
  }
  $results.Add([ordered]@{ path = [string]$requestedPath; status = $status })
}
[Console]::Out.Write(($results | ConvertTo-Json -Compress -Depth 3))
`;

export class DefaultWindowsSandboxReadProbe implements WindowsSandboxReadProbe {
  async pathAccess(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, WindowsSandboxReadStatus>> {
    const unique = [...new Map(
      paths.map((candidate) => [normalizedKey(candidate), path.win32.resolve(candidate)] as const),
    ).values()];
    if (unique.length === 0) return new Map<string, WindowsSandboxReadStatus>();

    const trustedPowerShell = powershellPath();
    await Promise.all([
      access(VENDORED_SRT_WIN_EXE, fsConstants.X_OK),
      access(trustedPowerShell, fsConstants.X_OK),
    ]);

    const input = Buffer.from(JSON.stringify(unique), "utf8").toString("base64");
    if (input.length > 12_000) {
      throw new Error("Windows SRT read probe input exceeds the safe argv budget");
    }
    const { stdout } = await execa(
      VENDORED_SRT_WIN_EXE,
      [
        "exec",
        "--quiet",
        "--env",
        `${WINDOWS_READ_PROBE_INPUT}=${input}`,
        "--",
        trustedPowerShell,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedPowerShellCommand(READ_PROBE_SCRIPT),
      ],
      {
        windowsHide: true,
        signal,
        timeout: WINDOWS_READ_PROBE_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        reject: true,
      },
    );

    const parsed = JSON.parse(stdout || "[]") as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const accessByPath = new Map<string, WindowsSandboxReadStatus>();
    const observed = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        throw new Error("Windows SRT read probe returned an invalid result");
      }
      const candidate = row as { path?: unknown; status?: unknown };
      if (
        typeof candidate.path !== "string" ||
        (candidate.status !== "readable" &&
          candidate.status !== "denied" &&
          candidate.status !== "unknown")
      ) {
        throw new Error("Windows SRT read probe returned an incomplete result");
      }
      const key = normalizedKey(candidate.path);
      if (!unique.some((value) => normalizedKey(value) === key)) {
        throw new Error("Windows SRT read probe returned an unexpected path");
      }
      if (observed.has(key)) {
        throw new Error("Windows SRT read probe returned a duplicate path");
      }
      observed.add(key);
      accessByPath.set(key, candidate.status);
    }
    if (observed.size !== unique.length) {
      throw new Error("Windows SRT read probe omitted a requested path");
    }
    return accessByPath;
  }
}

export function windowsSandboxReadKey(value: string): string {
  return normalizedKey(value);
}
