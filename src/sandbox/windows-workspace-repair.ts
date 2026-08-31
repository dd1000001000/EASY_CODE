import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

export interface WindowsWorkspaceOwnerRepair {
  readonly path: string;
  readonly owner: string;
  readonly inheritanceProtected: boolean;
  readonly daclSddl: string;
}

export interface WindowsWorkspaceRepairPreview {
  readonly target: string;
  readonly currentOwner: string;
  readonly currentOwnerSid: string;
  readonly scannedItems: number;
  readonly ownerRepairs: readonly WindowsWorkspaceOwnerRepair[];
  readonly skippedReparsePoints: readonly string[];
  readonly inspectionErrors: readonly string[];
}

export interface WindowsWorkspaceRepairResult {
  readonly before: WindowsWorkspaceRepairPreview;
  readonly after: WindowsWorkspaceRepairPreview;
  readonly elevated: boolean;
  readonly manifestPath: string;
}

export interface WindowsWorkspaceRepairService {
  inspect(target: string): Promise<WindowsWorkspaceRepairPreview>;
  apply(preview: WindowsWorkspaceRepairPreview): Promise<WindowsWorkspaceRepairResult>;
}

interface RawRepairPreview {
  target?: unknown;
  currentOwner?: unknown;
  currentOwnerSid?: unknown;
  scannedItems?: unknown;
  ownerRepairs?: unknown;
  skippedReparsePoints?: unknown;
  inspectionErrors?: unknown;
}

/**
 * Repairs only ownership left by CodexSandboxOffline. DACL entries, inherited
 * rules, and inheritance-protection flags are deliberately preserved. SRT can
 * then stage and restore its own temporary ACEs without EASY CODE broadening
 * access to the workspace.
 */
export class DefaultWindowsWorkspaceRepairService implements WindowsWorkspaceRepairService {
  constructor(
    private readonly platform = process.platform,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async inspect(target: string): Promise<WindowsWorkspaceRepairPreview> {
    const canonicalTarget = await validateWindowsWorkspaceRepairTarget(
      target,
      this.platform,
      this.environment,
    );
    const result = await runPowerShellJson(
      windowsPowerShellPath(this.environment),
      inspectScript(),
      { EASY_CODE_REPAIR_ROOT: canonicalTarget },
      this.environment,
    );
    return parseRepairPreview(result, canonicalTarget);
  }

  async apply(preview: WindowsWorkspaceRepairPreview): Promise<WindowsWorkspaceRepairResult> {
    if (this.platform !== "win32") {
      throw new Error("Workspace ownership repair is available only on Windows.");
    }
    if (preview.inspectionErrors.length > 0) {
      throw new Error(
        "Refusing ownership repair because the dry-run could not inspect every workspace item.",
      );
    }

    const canonicalTarget = await validateWindowsWorkspaceRepairTarget(
      preview.target,
      this.platform,
      this.environment,
    );
    if (!sameWindowsPath(canonicalTarget, preview.target)) {
      throw new Error("Workspace path changed after the repair dry-run; rerun the command.");
    }

    const powershell = windowsPowerShellPath(this.environment);
    const manifestDirectory = path.join(
      this.environment.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "easy-code",
      "sandbox-repair",
    );
    await mkdir(manifestDirectory, { recursive: true });
    const repairScript = applyScript();
    const repairScriptBytes = Buffer.from(repairScript, "utf8");
    const repairScriptSha256 = createHash("sha256")
      .update(repairScriptBytes)
      .digest("hex");
    const manifest = JSON.stringify({
      schemaVersion: 1,
      operation: "replace-codex-sandbox-offline-owner",
      createdAt: new Date().toISOString(),
      target: canonicalTarget,
      replacementOwner: preview.currentOwner,
      replacementOwnerSid: preview.currentOwnerSid,
      executorSha256: repairScriptSha256,
      items: preview.ownerRepairs,
    }, null, 2);
    const manifestBytes = Buffer.from(manifest, "utf8");
    const manifestPath = path.join(
      manifestDirectory,
      `workspace-owner-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.json`,
    );
    await writeFile(manifestPath, manifestBytes, { flag: "wx" });
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    // Windows limits a process command line to roughly 32 KiB. Keep the UAC
    // launcher small by storing the audited repair program beside the manifest
    // and passing only its path and hashes through Start-Process.
    const repairScriptPath = path.join(
      manifestDirectory,
      `workspace-owner-${randomUUID()}.ps1`,
    );
    const resultPath = path.join(
      manifestDirectory,
      `workspace-owner-${randomUUID()}.result.json`,
    );
    await writeFile(repairScriptPath, repairScriptBytes, { flag: "wx" });
    await writeFile(resultPath, "{\"ok\":false,\"message\":\"Elevated repair did not start.\"}", {
      encoding: "utf8",
      flag: "wx",
    });
    const elevatedInvocation = verifiedRepairBootstrap({
      repairScriptPath,
      repairScriptSha256,
      manifestPath,
      manifestSha256,
      resultPath,
    });
    const encodedInner = Buffer.from(elevatedInvocation, "utf16le").toString("base64");
    const outer = elevateScript(encodedInner, powershell);
    // Do not Base64-encode the outer launcher too: doing so expands the already
    // encoded bootstrap enough to approach CreateProcess' 32,767-char limit.
    const launchArguments = powershellCommandArgs(outer);
    const launchCommandLength = [powershell, ...launchArguments].join(" ").length;
    if (launchCommandLength >= 24_000) {
      await Promise.all([
        rm(repairScriptPath, { force: true }),
        rm(resultPath, { force: true }),
      ]);
      throw new Error(
        `Internal workspace repair launcher exceeded its safe Windows command-line budget (${launchCommandLength} characters). ` +
          `Backup manifest: ${manifestPath}`,
      );
    }

    let launchError: unknown;
    try {
      await execFileAsync(powershell, launchArguments, {
        windowsHide: false,
        timeout: 15 * 60_000,
        maxBuffer: OUTPUT_LIMIT_BYTES,
        env: minimalPowerShellEnvironment(this.environment),
      });
    } catch (error) {
      launchError = error;
    } finally {
      await rm(repairScriptPath, { force: true }).catch(() => undefined);
    }

    const elevatedResult = await readElevatedRepairResult(resultPath);
    await rm(resultPath, { force: true }).catch(() => undefined);
    if (launchError || !elevatedResult.ok) {
      const resultDetail = elevatedResult.message.trim();
      const launchDetail = commandErrorDetail(launchError);
      const detail = resultDetail || launchDetail;
      throw new Error(
        `Elevated workspace ownership repair failed or the UAC prompt was canceled${detail ? `: ${detail}` : "."} ` +
          `Backup manifest: ${manifestPath}`,
      );
    }

    const after = await this.inspect(canonicalTarget);
    return { before: preview, after, elevated: true, manifestPath };
  }
}

export async function validateWindowsWorkspaceRepairTarget(
  target: string,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (platform !== "win32") {
    throw new Error("Workspace ownership repair is available only on Windows.");
  }
  const trimmed = target.trim();
  if (!trimmed || !path.win32.isAbsolute(trimmed)) {
    throw new Error("Provide an explicit absolute local workspace path.");
  }
  if (trimmed.startsWith("\\\\")) {
    throw new Error("UNC and network paths cannot be repaired by this command.");
  }

  const canonical = path.win32.normalize(await realpath(trimmed));
  const parsed = path.win32.parse(canonical);
  if (sameWindowsPath(canonical, parsed.root)) {
    throw new Error("Refusing to repair a drive root.");
  }

  const protectedTrees = [
    environment.SystemRoot,
    environment.windir,
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
    environment.ProgramData,
  ].filter((value): value is string => Boolean(value?.trim()));
  if (protectedTrees.some((value) => isPathInsideWindowsTarget(path.win32.normalize(value), canonical))) {
    throw new Error("Refusing to repair a protected operating-system or user-profile root.");
  }
  if (sameWindowsPath(canonical, path.win32.normalize(os.homedir()))) {
    throw new Error("Refusing to repair a protected operating-system or user-profile root.");
  }

  const metadata = await lstat(canonical);
  if (!metadata.isDirectory()) throw new Error("Workspace repair target must be a directory.");
  if (metadata.isSymbolicLink()) {
    throw new Error("Workspace repair target cannot be a symbolic link or junction.");
  }
  return canonical;
}

export function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.normalize(left).replace(/[\\/]+$/u, "").toLocaleLowerCase("en-US") ===
    path.win32.normalize(right).replace(/[\\/]+$/u, "").toLocaleLowerCase("en-US");
}

function windowsPowerShellPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot ?? environment.windir ?? "C:\\Windows";
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function powershellArgs(script: string): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function powershellCommandArgs(script: string): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ];
}

async function runPowerShellJson(
  powershell: string,
  script: string,
  additions: Readonly<Record<string, string>>,
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const { stdout } = await execFileAsync(powershell, powershellArgs(script), {
    windowsHide: true,
    timeout: 5 * 60_000,
    maxBuffer: OUTPUT_LIMIT_BYTES,
    env: { ...minimalPowerShellEnvironment(environment), ...additions },
  });
  const text = stdout.trim();
  if (!text) throw new Error("Workspace ownership inspection returned no result.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Workspace ownership inspection returned malformed JSON.");
  }
}

function minimalPowerShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    "SystemRoot",
    "windir",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
  ] as const;
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (source[key]) result[key] = source[key];
  }
  return result;
}

function inspectScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($env:EASY_CODE_REPAIR_ROOT)
$resolved = (Resolve-Path -LiteralPath $root -ErrorAction Stop).ProviderPath
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($root.TrimEnd('\\'), $resolved.TrimEnd('\\'))) {
  throw 'Workspace canonical path changed during inspection.'
}
$rootItem = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Workspace repair target cannot be a reparse point.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$ownerRepairs = [Collections.Generic.List[object]]::new()
$skipped = [Collections.Generic.List[string]]::new()
$errors = [Collections.Generic.List[string]]::new()
$items = [Collections.Generic.List[object]]::new()
$items.Add($rootItem)
try {
  foreach ($item in Get-ChildItem -LiteralPath $resolved -Force -Recurse -ErrorAction Stop) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $skipped.Add($item.FullName)
      continue
    }
    $items.Add($item)
  }
} catch {
  $errors.Add(('Enumeration failed: ' + $_.Exception.Message))
}
foreach ($item in $items) {
  try {
    if ([string]$item.LinkType -eq 'HardLink') {
      throw 'Hard-linked files cannot be repaired safely because ownership is shared outside the listed path.'
    }
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    if ($acl.Owner -match '(?i)\\CodexSandboxOffline$') {
      $ownerRepairs.Add([ordered]@{
        path = $item.FullName
        owner = $acl.Owner
        inheritanceProtected = [bool]$acl.AreAccessRulesProtected
        daclSddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
      })
    }
  } catch {
    $errors.Add(($item.FullName + ': ' + $_.Exception.Message))
  }
}
[ordered]@{
  target = $resolved
  currentOwner = $identity.Name
  currentOwnerSid = $identity.User.Value
  scannedItems = $items.Count
  ownerRepairs = @($ownerRepairs)
  skippedReparsePoints = @($skipped)
  inspectionErrors = @($errors)
} | ConvertTo-Json -Depth 5 -Compress
`;
}

function applyScript(): string {
  return String.raw`
param(
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$ManifestSha256
)
$ErrorActionPreference = 'Stop'
function Assert-NoReparseChain([string]$CandidatePath) {
  $full = [IO.Path]::GetFullPath($CandidatePath)
  $pathRoot = [IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($pathRoot)) {
    throw 'Repair path has no Windows drive root.'
  }
  $current = $pathRoot
  $rootNode = Get-Item -LiteralPath $current -Force -ErrorAction Stop
  if (($rootNode.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw ('Repair path contains a reparse-point ancestor: ' + $current)
  }
  $relative = $full.Substring($pathRoot.Length)
  $segments = $relative.Split(
    [char[]]@('\', '/'),
    [StringSplitOptions]::RemoveEmptyEntries
  )
  foreach ($segment in $segments) {
    $current = Join-Path $current $segment
    $node = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($node.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw ('Repair path contains a reparse-point ancestor: ' + $current)
    }
  }
  return $full
}
$manifestBytes = [IO.File]::ReadAllBytes($ManifestPath)
$hasher = [Security.Cryptography.SHA256]::Create()
try {
  $actualManifestHash = ([BitConverter]::ToString($hasher.ComputeHash($manifestBytes))).Replace('-', '').ToLowerInvariant()
} finally {
  $hasher.Dispose()
}
if ($actualManifestHash -ne $ManifestSha256) {
  throw 'Workspace repair manifest changed after approval.'
}
  $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
  if ([int]$manifest.schemaVersion -ne 1 -or [string]$manifest.operation -ne 'replace-codex-sandbox-offline-owner') {
    throw 'Unsupported workspace repair manifest.'
  }
  $root = Assert-NoReparseChain ([string]$manifest.target)
  $resolved = (Resolve-Path -LiteralPath $root -ErrorAction Stop).ProviderPath
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($root.TrimEnd('\\'), $resolved.TrimEnd('\\'))) {
    throw 'Workspace canonical path changed after confirmation.'
  }
  $driveRoot = [IO.Path]::GetPathRoot($resolved).TrimEnd('\\')
  if ([StringComparer]::OrdinalIgnoreCase.Equals($driveRoot, $resolved.TrimEnd('\\'))) {
    throw 'Refusing to repair a drive root.'
  }
  foreach ($protected in @($env:SystemRoot, $env:windir, $env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $env:ProgramData)) {
    if ([string]::IsNullOrWhiteSpace($protected)) { continue }
    $protectedPath = [IO.Path]::GetFullPath($protected).TrimEnd('\\')
    $candidate = $resolved.TrimEnd('\\')
    if (
      [StringComparer]::OrdinalIgnoreCase.Equals($protectedPath, $candidate) -or
      $candidate.StartsWith(($protectedPath + '\'), [StringComparison]::OrdinalIgnoreCase)
    ) {
      throw 'Refusing to repair a protected operating-system directory.'
    }
  }
  $rootItem = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Workspace repair target cannot be a reparse point.'
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($identity.User.Value -ne [string]$manifest.replacementOwnerSid) {
    throw 'Elevated process does not belong to the user who approved the dry-run.'
  }
  $takeown = Join-Path $env:SystemRoot 'System32\takeown.exe'
  if (-not (Test-Path -LiteralPath $takeown -PathType Leaf)) { throw 'takeown.exe is unavailable.' }
  $failures = [Collections.Generic.List[string]]::new()
  foreach ($entry in @($manifest.items)) {
    $itemPath = [string]$entry.path
    try {
      $itemPath = [IO.Path]::GetFullPath($itemPath)
      $workspacePrefix = $resolved.TrimEnd('\') + '\'
      if (
        -not [StringComparer]::OrdinalIgnoreCase.Equals($resolved.TrimEnd('\\'), $itemPath.TrimEnd('\\')) -and
        -not $itemPath.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)
      ) {
        throw 'Manifest item escaped the workspace target.'
      }
      [void](Assert-NoReparseChain $resolved)
      $itemPath = Assert-NoReparseChain $itemPath
      $item = Get-Item -LiteralPath $itemPath -Force -ErrorAction Stop
      if ([string]$item.LinkType -eq 'HardLink') {
        throw 'Refusing to repair a hard-linked file.'
      }
      $acl = Get-Acl -LiteralPath $itemPath -ErrorAction Stop
      $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      if ($ownerSid -eq [string]$manifest.replacementOwnerSid) { continue }
      if ($acl.Owner -notmatch '(?i)\\CodexSandboxOffline$' -or $acl.Owner -ne [string]$entry.owner) {
        throw 'Owner changed after dry-run; rerun repair-workspace.'
      }
      $currentDacl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
      if (
        $currentDacl -ne [string]$entry.daclSddl -or
        [bool]$acl.AreAccessRulesProtected -ne [bool]$entry.inheritanceProtected
      ) {
        throw 'DACL or inheritance changed after dry-run; rerun repair-workspace.'
      }
      # Recheck immediately before the path-based privileged operation. This
      # narrows the dry-run/UAC junction race and fails closed if any ancestor
      # changed while the confirmation dialog was open.
      [void](Assert-NoReparseChain $resolved)
      [void](Assert-NoReparseChain $itemPath)
      $takeownOutput = (& $takeown /F $itemPath 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -ne 0) {
        throw ('takeown.exe failed: ' + $takeownOutput)
      }
      [void](Assert-NoReparseChain $resolved)
      [void](Assert-NoReparseChain $itemPath)
      $verified = Get-Acl -LiteralPath $itemPath -ErrorAction Stop
      $verifiedOwnerSid = $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value
      if ($verifiedOwnerSid -ne [string]$manifest.replacementOwnerSid) {
        throw 'takeown.exe did not assign the approved replacement owner.'
      }
      $verifiedDacl = $verified.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
      if ($verifiedDacl -ne [string]$entry.daclSddl) {
        throw 'DACL changed unexpectedly while replacing the owner.'
      }
    } catch {
      $failures.Add(($itemPath + ': ' + $_.Exception.Message))
    }
  }
  if ($failures.Count -gt 0) {
    throw ('Some workspace objects could not be repaired: ' + ($failures -join '; '))
  }
`;
}

function verifiedRepairBootstrap(input: {
  repairScriptPath: string;
  repairScriptSha256: string;
  manifestPath: string;
  manifestSha256: string;
  resultPath: string;
}): string {
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  return String.raw`
$ErrorActionPreference = 'Stop'
$validatedResultPath = $null
function Get-Sha256([byte[]]$Bytes) {
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
}
function Write-RepairResult([bool]$Ok, [string]$Message, [string]$OutputPath) {
  $json = [ordered]@{ ok = $Ok; message = $Message } | ConvertTo-Json -Compress
  $utf8 = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($OutputPath, $json, $utf8)
}
try {
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
  $helperPath = [IO.Path]::GetFullPath([string]$payload.repairScriptPath)
  $manifestPath = [IO.Path]::GetFullPath([string]$payload.manifestPath)
  $candidateResultPath = [IO.Path]::GetFullPath([string]$payload.resultPath)
  $expectedDirectory = [IO.Path]::GetDirectoryName($manifestPath)
  if (
    -not [StringComparer]::OrdinalIgnoreCase.Equals($expectedDirectory, [IO.Path]::GetDirectoryName($helperPath)) -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals($expectedDirectory, [IO.Path]::GetDirectoryName($candidateResultPath))
  ) {
    throw 'Workspace repair helper paths escaped the repair directory.'
  }
  foreach ($candidate in @($helperPath, $manifestPath, $candidateResultPath)) {
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Workspace repair helper files cannot be reparse points.'
    }
  }
  $validatedResultPath = $candidateResultPath
  $helperBytes = [IO.File]::ReadAllBytes($helperPath)
  if ((Get-Sha256 $helperBytes) -ne [string]$payload.repairScriptSha256) {
    throw 'Workspace repair script changed after approval.'
  }
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  if ((Get-Sha256 $manifestBytes) -ne [string]$payload.manifestSha256) {
    throw 'Workspace repair manifest changed after approval.'
  }
  $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
  if ([string]$manifest.executorSha256 -ne [string]$payload.repairScriptSha256) {
    throw 'Workspace repair manifest was not bound to the approved executor.'
  }
  $scriptBlock = [ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($helperBytes))
  & $scriptBlock -ManifestPath $manifestPath -ManifestSha256 ([string]$payload.manifestSha256)
  Write-RepairResult $true 'Workspace ownership repair completed.' $validatedResultPath
  exit 0
} catch {
  $message = $_.Exception.Message
  if ($validatedResultPath) {
    try { Write-RepairResult $false $message $validatedResultPath } catch {}
  }
  [Console]::Error.WriteLine($message)
  exit 1
}
`;
}

function elevateScript(encodedInner: string, powershell: string): string {
  const quotedPowerShell = powershell.replace(/'/gu, "''");
  return String.raw`
$ErrorActionPreference = 'Stop'
$process = Start-Process -FilePath '${quotedPowerShell}' -Verb RunAs -Wait -PassThru -ArgumentList @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', '${encodedInner}'
)
exit $process.ExitCode
`;
}

function parseRepairPreview(value: unknown, expectedTarget: string): WindowsWorkspaceRepairPreview {
  if (!value || typeof value !== "object") {
    throw new Error("Workspace ownership inspection returned an invalid result.");
  }
  const raw = value as RawRepairPreview;
  const target = requireString(raw.target, "target");
  if (!sameWindowsPath(target, expectedTarget)) {
    throw new Error("Workspace ownership inspection escaped the requested target.");
  }
  const ownerRepairs = requireArray(raw.ownerRepairs, "ownerRepairs").map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Workspace ownership inspection returned an invalid owner repair.");
    }
    const record = entry as Record<string, unknown>;
    const itemPath = requireString(record.path, "owner repair path");
    if (!isPathInsideWindowsTarget(expectedTarget, itemPath)) {
      throw new Error("Workspace ownership inspection returned a path outside the target.");
    }
    return {
      path: itemPath,
      owner: requireString(record.owner, "owner repair owner"),
      inheritanceProtected: Boolean(record.inheritanceProtected),
      daclSddl: requireString(record.daclSddl, "owner repair DACL"),
    };
  });
  return {
    target,
    currentOwner: requireString(raw.currentOwner, "currentOwner"),
    currentOwnerSid: requireString(raw.currentOwnerSid, "currentOwnerSid"),
    scannedItems: requireNonNegativeInteger(raw.scannedItems, "scannedItems"),
    ownerRepairs,
    skippedReparsePoints: requireStringArray(raw.skippedReparsePoints, "skippedReparsePoints"),
    inspectionErrors: requireStringArray(raw.inspectionErrors, "inspectionErrors"),
  };
}

function isPathInsideWindowsTarget(root: string, candidate: string): boolean {
  const relative = path.win32.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..\\") && relative !== ".." && !path.win32.isAbsolute(relative));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Workspace ownership inspection omitted ${field}.`);
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Workspace ownership inspection omitted ${field}.`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  return requireArray(value, field).map((entry) => requireString(entry, field));
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Workspace ownership inspection returned invalid ${field}.`);
  }
  return value;
}

async function readElevatedRepairResult(
  resultPath: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const parsed = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid result object");
    const record = parsed as Record<string, unknown>;
    if (typeof record.ok !== "boolean" || typeof record.message !== "string") {
      throw new Error("invalid result fields");
    }
    return { ok: record.ok, message: record.message };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Elevated repair returned no trustworthy result (${detail}).`,
    };
  }
}

function commandErrorDetail(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as { stderr?: unknown; message?: unknown };
  if (typeof record.stderr === "string" && record.stderr.trim()) return record.stderr.trim();
  return typeof record.message === "string" ? record.message : "";
}
