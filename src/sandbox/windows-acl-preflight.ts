import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

export interface WindowsAclMutationProbe {
  readonly path: string;
  readonly reasons: readonly string[];
}

export interface WindowsAclPreflightEntry {
  readonly path: string;
  readonly owner: string;
  readonly canWriteDacl: boolean;
  readonly error?: string;
}

export interface WindowsAclPreflightReport {
  readonly identity: string;
  readonly entries: readonly WindowsAclPreflightEntry[];
}

export interface WindowsAclPreflight {
  check(
    probes: readonly WindowsAclMutationProbe[],
    options?: { readonly repairTarget?: string },
  ): Promise<void>;
}

const WINDOWS_ACL_PREFLIGHT_TIMEOUT_MS = 8_000;

// AccessCheck is the Windows authorization API used by the kernel for an
// effective-access decision. Merely comparing the owner or walking ALLOW ACEs
// is not sufficient: group membership, inherited DENY ACEs, and a filtered
// administrator token all affect WRITE_DAC.
const ACCESS_CHECK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class EasyCodeAclAccessCheck
{
    private const UInt32 TOKEN_DUPLICATE = 0x0002;
    private const UInt32 TOKEN_QUERY = 0x0008;
    private const UInt32 WRITE_DAC = 0x00040000;
    private const Int32 SecurityImpersonation = 2;
    private const Int32 ERROR_INSUFFICIENT_BUFFER = 122;

    [StructLayout(LayoutKind.Sequential)]
    private struct GENERIC_MAPPING
    {
        public UInt32 GenericRead;
        public UInt32 GenericWrite;
        public UInt32 GenericExecute;
        public UInt32 GenericAll;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(
        IntPtr processHandle,
        UInt32 desiredAccess,
        out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateToken(
        IntPtr existingToken,
        Int32 impersonationLevel,
        out IntPtr duplicateToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AccessCheck(
        IntPtr securityDescriptor,
        IntPtr clientToken,
        UInt32 desiredAccess,
        ref GENERIC_MAPPING genericMapping,
        IntPtr privilegeSet,
        ref UInt32 privilegeSetLength,
        out UInt32 grantedAccess,
        out bool accessStatus);

    public static bool CanWriteDacl(byte[] securityDescriptor)
    {
        IntPtr primaryToken = IntPtr.Zero;
        IntPtr impersonationToken = IntPtr.Zero;
        GCHandle descriptorHandle = default(GCHandle);
        IntPtr privilegeSet = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_QUERY | TOKEN_DUPLICATE,
                    out primaryToken))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!DuplicateToken(
                    primaryToken,
                    SecurityImpersonation,
                    out impersonationToken))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            descriptorHandle = GCHandle.Alloc(securityDescriptor, GCHandleType.Pinned);
            var mapping = new GENERIC_MAPPING
            {
                GenericRead = 0x00120089,
                GenericWrite = 0x00120116,
                GenericExecute = 0x001200A0,
                GenericAll = 0x001F01FF,
            };
            UInt32 privilegeSetLength = 0;
            UInt32 grantedAccess;
            bool accessStatus;
            AccessCheck(
                descriptorHandle.AddrOfPinnedObject(),
                impersonationToken,
                WRITE_DAC,
                ref mapping,
                IntPtr.Zero,
                ref privilegeSetLength,
                out grantedAccess,
                out accessStatus);
            var firstError = Marshal.GetLastWin32Error();
            if (firstError != ERROR_INSUFFICIENT_BUFFER)
                throw new Win32Exception(firstError);

            privilegeSet = Marshal.AllocHGlobal((Int32)privilegeSetLength);
            if (!AccessCheck(
                    descriptorHandle.AddrOfPinnedObject(),
                    impersonationToken,
                    WRITE_DAC,
                    ref mapping,
                    privilegeSet,
                    ref privilegeSetLength,
                    out grantedAccess,
                    out accessStatus))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return accessStatus && (grantedAccess & WRITE_DAC) == WRITE_DAC;
        }
        finally
        {
            if (privilegeSet != IntPtr.Zero) Marshal.FreeHGlobal(privilegeSet);
            if (descriptorHandle.IsAllocated) descriptorHandle.Free();
            if (impersonationToken != IntPtr.Zero) CloseHandle(impersonationToken);
            if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
        }
    }
}
'@

$requests = @((ConvertFrom-Json ([Console]::In.ReadToEnd())))
$entries = @()
foreach ($request in $requests) {
  try {
    $item = Get-Item -LiteralPath ([string]$request.path) -Force -ErrorAction Stop
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    $entries += [pscustomobject]@{
      path = [string]$item.FullName
      owner = [string]$acl.Owner
      canWriteDacl = [EasyCodeAclAccessCheck]::CanWriteDacl(
        $acl.GetSecurityDescriptorBinaryForm()
      )
    }
  } catch {
    $entries += [pscustomobject]@{
      path = [string]$request.path
      owner = '<unknown>'
      canWriteDacl = $false
      error = [string]$_.Exception.Message
    }
  }
}

$result = [pscustomobject]@{
  identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  entries = @($entries)
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
`;

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function findWindowsPowerShell(): Promise<string> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executablePath = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    await access(executablePath, fsConstants.X_OK);
  } catch {
    throw new Error(
      `Windows SRT ACL preflight cannot find the trusted Windows PowerShell executable at ${executablePath}`,
    );
  }
  return executablePath;
}

function reportFromJson(value: string): WindowsAclPreflightReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Windows SRT ACL preflight returned unreadable output");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Windows SRT ACL preflight returned an invalid report");
  }
  const candidate = parsed as {
    identity?: unknown;
    entries?: unknown;
  };
  if (typeof candidate.identity !== "string" || !Array.isArray(candidate.entries)) {
    throw new Error("Windows SRT ACL preflight returned an incomplete report");
  }
  const entries = candidate.entries.map((entry): WindowsAclPreflightEntry => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Windows SRT ACL preflight returned an invalid path entry");
    }
    const item = entry as {
      path?: unknown;
      owner?: unknown;
      canWriteDacl?: unknown;
      error?: unknown;
    };
    if (
      typeof item.path !== "string" ||
      typeof item.owner !== "string" ||
      typeof item.canWriteDacl !== "boolean"
    ) {
      throw new Error("Windows SRT ACL preflight returned an incomplete path entry");
    }
    return {
      path: item.path,
      owner: item.owner,
      canWriteDacl: item.canWriteDacl,
      ...(typeof item.error === "string" ? { error: item.error } : {}),
    };
  });
  return { identity: candidate.identity, entries };
}

function normalizedKey(value: string): string {
  return path.resolve(value).toLowerCase();
}

export function formatWindowsAclPreflightFailure(
  report: WindowsAclPreflightReport,
  probes: readonly WindowsAclMutationProbe[],
  repairTarget?: string,
): string | undefined {
  const failed = report.entries.filter((entry) => !entry.canWriteDacl);
  if (failed.length === 0) return undefined;
  const reasons = new Map(
    probes.map((probe) => [normalizedKey(probe.path), probe.reasons] as const),
  );
  const shown = failed.slice(0, 8).map((entry) => {
    const neededFor = reasons.get(normalizedKey(entry.path)) ?? ["Windows SRT ACL setup"];
    return `- ${entry.path} (owner: ${entry.owner}; needed for: ${neededFor.join(", ")})` +
      (entry.error ? `; inspection error: ${entry.error}` : "");
  });
  if (failed.length > shown.length) {
    shown.push(`- ...and ${String(failed.length - shown.length)} more path(s)`);
  }
  const repairPath = repairTarget ?? failed[0]?.path;
  const dryRun = repairPath
    ? `First run the safe dry-run: easy-code sandbox repair-workspace --target "${repairPath}"`
    : "First run `easy-code sandbox repair-workspace --target <exact-workspace-path>` as a safe dry-run.";
  const apply = repairPath
    ? `After reviewing the exact owner changes, apply them with: easy-code sandbox repair-workspace --target "${repairPath}" --apply --confirm "${repairPath}"`
    : "Apply only after reviewing that dry-run; the command requires --apply and an exact --confirm path.";
  return [
    `Windows SRT ACL preflight failed for ${report.identity}: the current token lacks WRITE_DAC (Change permissions) on path(s) that the sandbox must stamp.`,
    ...shown,
    "The target command was not started; EASY CODE stopped before the 75-second SRT initialization timeout.",
    dryRun,
    apply,
    "The repair changes only CodexSandboxOffline-owned objects reported by the dry-run and preserves existing DACL/inheritance settings. Retry the command afterward. `easy-code sandbox doctor` checks the base installation only; it does not validate this workspace's ACLs.",
  ].join("\n");
}

export class DefaultWindowsAclPreflight implements WindowsAclPreflight {
  async check(
    probes: readonly WindowsAclMutationProbe[],
    options: { readonly repairTarget?: string } = {},
  ): Promise<void> {
    if (probes.length === 0) return;
    const powershell = await findWindowsPowerShell();
    const input = JSON.stringify(probes.map((probe) => ({ path: probe.path })));
    let result;
    try {
      result = await execa(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodedPowerShellCommand(ACCESS_CHECK_SCRIPT),
        ],
        {
          input,
          timeout: WINDOWS_ACL_PREFLIGHT_TIMEOUT_MS,
          windowsHide: true,
          reject: false,
        },
      );
    } catch (error) {
      throw new Error(
        `Windows SRT ACL preflight could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.timedOut) {
      throw new Error(
        `Windows SRT ACL preflight timed out after ${String(WINDOWS_ACL_PREFLIGHT_TIMEOUT_MS)}ms; the target command was not started`,
      );
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "unknown PowerShell failure";
      throw new Error(`Windows SRT ACL preflight failed to inspect permissions: ${detail}`);
    }
    const report = reportFromJson(result.stdout.trim());
    const failure = formatWindowsAclPreflightFailure(report, probes, options.repairTarget);
    if (failure) throw new Error(failure);
  }
}
