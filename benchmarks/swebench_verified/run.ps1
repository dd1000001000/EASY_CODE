[CmdletBinding()]
param(
    [ValidateSet("smoke", "full")]
    [string]$Scope = "smoke",

    [string]$TaskId = "django__django-11790",

    [string]$DataRoot = "F:\easy-code-bench\swe-bench-verified-50",

    [ValidateRange(1, 50)]
    [int]$Concurrency = 1,

    [string]$RunId = "",

    [switch]$ConfirmFullRun,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if ([IO.Path]::GetPathRoot($DataRoot) -ne "F:\") {
    throw "Benchmark data must remain on the F: drive."
}
if ($RunId -and $RunId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw "RunId must start with an alphanumeric character and contain only letters, numbers, ., _, or -."
}

$manifestPath = Join-Path $PSScriptRoot "subset-50.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$instanceIds = @($manifest.instance_ids)
if ($instanceIds.Count -ne 50 -or @($instanceIds | Sort-Object -Unique).Count -ne 50) {
    throw "The pinned manifest must contain 50 distinct task IDs."
}

$offset = 0
$limit = 1
if ($Scope -eq "full") {
    if (-not $ConfirmFullRun) {
        throw "A 50-task run can consume substantial API credits. Re-run with -Scope full -ConfirmFullRun."
    }
    $limit = 50
} else {
    $offset = [Array]::IndexOf($instanceIds, $TaskId)
    if ($offset -lt 0) {
        throw "Smoke task '$TaskId' is not in the pinned 50-task manifest."
    }
}

if ([string]::IsNullOrWhiteSpace($RunId)) {
    $RunId = if ($Scope -eq "full") { "verified-mini-50" } else { "smoke-$TaskId" }
}

$arguments = @(
    "benchmark", "swe-bench", "run",
    "--root", $DataRoot,
    "--offset", $offset.ToString(),
    "--limit", $limit.ToString(),
    "--concurrency", $Concurrency.ToString(),
    "--run-id", $RunId
)
if ($Scope -eq "full") { $arguments += "--confirm-full-run" }
if ($DryRun) { $arguments += "--dry-run" }
if (-not [string]::IsNullOrWhiteSpace($env:EASY_CODE_PACKAGE_PATH)) {
    $packagePath = (Resolve-Path -LiteralPath $env:EASY_CODE_PACKAGE_PATH).Path
    if ([IO.Path]::GetExtension($packagePath) -ne ".tgz") {
        throw "EASY_CODE_PACKAGE_PATH must reference an npm .tgz package."
    }
    $arguments += @("--package", $packagePath)
}

# The integrated launcher owns registry validation, credential staging, Docker
# preflight, network policy, checkpoints and cleanup. Keeping this script as a
# thin wrapper prevents a second provider catalog or security path from drifting.
$easyCode = (Get-Command easy-code -ErrorAction Stop).Source
& $easyCode @arguments
exit $LASTEXITCODE
