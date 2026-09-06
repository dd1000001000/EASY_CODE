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
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$catalogPath = Join-Path $repositoryRoot "resources\prompt-bundle\models\catalog.json"
$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
$benchmarkProfile = $catalog.profiles.sweBenchVerified50
if ($null -eq $benchmarkProfile) {
    throw "The model catalog does not define profiles.sweBenchVerified50."
}
$benchmarkProvider = @($catalog.providers) |
    Where-Object { $_.id -eq $benchmarkProfile.provider } |
    Select-Object -First 1
if ($null -eq $benchmarkProvider) {
    throw "The SWE-bench provider '$($benchmarkProfile.provider)' is absent from the model catalog."
}
if ($benchmarkProvider.id -ne "glm-coding-plan") {
    throw "The SWE-bench profile must use the dedicated GLM Coding Plan provider."
}
if (-not (@($benchmarkProvider.models).id -contains $benchmarkProfile.model)) {
    throw "The SWE-bench model '$($benchmarkProfile.model)' is absent from provider '$($benchmarkProvider.id)'."
}
$benchmarkApiKeyEnvironmentNames = @($benchmarkProvider.environment.apiKey)
if ($benchmarkApiKeyEnvironmentNames.Count -ne 1) {
    throw "The SWE-bench provider must define one dedicated API-key environment name."
}
$allProviderEnvironmentNames = @(
    foreach ($provider in @($catalog.providers)) {
        foreach ($category in @("apiKey", "baseUrl", "model", "timeoutMs", "maxRetries")) {
            @($provider.environment.$category)
        }
    }
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique
$harborModel = "$($benchmarkProfile.provider)/$($benchmarkProfile.model)"
$providerUri = [Uri]$benchmarkProvider.defaultBaseUrl
$allowAgentHost = $providerUri.Host
if (-not $providerUri.IsAbsoluteUri -or $providerUri.Scheme -ne "https" -or [string]::IsNullOrWhiteSpace($allowAgentHost)) {
    throw "The SWE-bench provider must define a valid HTTPS endpoint."
}
if ([string]::IsNullOrWhiteSpace($RunId)) {
    $RunId = "verified-50-$($benchmarkProfile.provider)-$($benchmarkProfile.model)"
}
$manifestPath = Join-Path $PSScriptRoot "subset-50.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$instanceIds = @($manifest.instance_ids)

if ($instanceIds.Count -ne 50) {
    throw "The pinned manifest must contain exactly 50 task IDs."
}
if (@($instanceIds | Sort-Object -Unique).Count -ne 50) {
    throw "The pinned manifest contains duplicate task IDs."
}

if ($Scope -eq "full") {
    if (-not $ConfirmFullRun) {
        throw "A 50-task run can consume substantial API credits. Re-run with -Scope full -ConfirmFullRun."
    }
    $selectedIds = $instanceIds
} else {
    if ($instanceIds -notcontains $TaskId) {
        throw "Smoke task '$TaskId' is not in the pinned 50-task manifest."
    }
    $selectedIds = @($TaskId)
}

$jobsDir = Join-Path $DataRoot "jobs"
$homeDir = Join-Path $DataRoot "home"
$cacheDir = Join-Path $DataRoot "cache"
$tempDir = Join-Path $DataRoot "tmp"

$harborArgs = @(
    "run",
    "--dataset", "swe-bench/swe-bench-verified@sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341",
    "--agent", "benchmarks.swebench_verified.easy_code_agent:EasyCodeAgent",
    "--model", $harborModel,
    "--jobs-dir", $jobsDir,
    "--job-name", $RunId,
    "--n-concurrent", $Concurrency.ToString(),
    "--n-attempts", "1",
    "--agent-setup-timeout-multiplier", "4",
    "--yes",
    "--allow-agent-host", $allowAgentHost
)
foreach ($id in $selectedIds) {
    # Harbor task names are organization-prefixed. Exact names avoid an empty
    # or overly broad filter silently becoming a full 500-task run.
    $harborArgs += @("--include-task-name", "swe-bench/$id")
}

if ($DryRun) {
    Write-Output "Working directory: $repositoryRoot"
    Write-Output "Harbor arguments:"
    $harborArgs | ForEach-Object { Write-Output "  $_" }
    exit 0
}

@($jobsDir, $homeDir, $cacheDir, $tempDir) | ForEach-Object {
    New-Item -ItemType Directory -Path $_ -Force | Out-Null
}

if ([string]::IsNullOrWhiteSpace($env:EASY_CODE_PACKAGE_PATH)) {
    throw "Set EASY_CODE_PACKAGE_PATH to the absolute path of a locally built npm .tgz package."
}
$packagePath = (Resolve-Path -LiteralPath $env:EASY_CODE_PACKAGE_PATH).Path
if ([IO.Path]::GetExtension($packagePath) -ne ".tgz") {
    throw "EASY_CODE_PACKAGE_PATH must reference an npm .tgz package."
}
$env:EASY_CODE_PACKAGE_PATH = $packagePath

$apiKey = @($benchmarkApiKeyEnvironmentNames | ForEach-Object {
    [Environment]::GetEnvironmentVariable($_, "Process")
}) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "$($benchmarkApiKeyEnvironmentNames[0]) is required in this PowerShell process."
}

$pinnedHarbor = Join-Path $DataRoot "python\Scripts\harbor.exe"
$harborPath = if (Test-Path -LiteralPath $pinnedHarbor) {
    (Resolve-Path -LiteralPath $pinnedHarbor).Path
} else {
    (Get-Command harbor -ErrorAction Stop).Source
}
Get-Command docker -ErrorAction Stop | Out-Null

$savedEnvironment = @{}
$launcherDirectory = (Get-Location).Path
$hostDockerConfig = if (-not [string]::IsNullOrWhiteSpace($env:DOCKER_CONFIG)) {
    [IO.Path]::GetFullPath($env:DOCKER_CONFIG, $launcherDirectory)
} elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    Join-Path $env:USERPROFILE ".docker"
} else {
    Join-Path ([Environment]::GetFolderPath("UserProfile")) ".docker"
}
$benchmarkEnvironment = @{
    HOME = $homeDir
    USERPROFILE = $homeDir
    HF_HOME = (Join-Path $cacheDir "huggingface")
    XDG_CACHE_HOME = $cacheDir
    PIP_CACHE_DIR = (Join-Path $cacheDir "pip")
    UV_CACHE_DIR = (Join-Path $cacheDir "uv")
    npm_config_cache = (Join-Path $cacheDir "npm")
    TEMP = $tempDir
    TMP = $tempDir
    PYTHONPATH = $repositoryRoot
}
if (-not [string]::IsNullOrWhiteSpace($hostDockerConfig)) {
    # Docker Desktop keeps Compose v2 in the original user's CLI-plugin
    # directory. Preserve that lookup while Harbor and benchmark caches use F:.
    $benchmarkEnvironment.DOCKER_CONFIG = $hostDockerConfig
}
$providerEnvironmentNames = @($allProviderEnvironmentNames) + @(
    "EASY_CODE_GLM_API_KEY_FILE",
    "EASY_CODE_GLM_CODING_PLAN_API_KEY_FILE",
    "EASY_CODE_GLM_CODING_PLAN_KEY_FILE"
) | Sort-Object -Unique
foreach ($name in $providerEnvironmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

$secretDirectory = Join-Path $tempDir ("glm-coding-plan-secret-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -LiteralPath $secretDirectory | Out-Null
$secretFile = Join-Path $secretDirectory "glm-coding-plan-api-key"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
$commandExitCode = 1
try {
    & $icacls $secretDirectory "/inheritance:r" "/grant:r" "*${sid}:(OI)(CI)F" "/grant:r" "*S-1-5-18:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to protect the temporary GLM Coding Plan credential directory with a Windows ACL."
    }
    [IO.File]::WriteAllText($secretFile, $apiKey, [Text.UTF8Encoding]::new($false))
    $benchmarkEnvironment.EASY_CODE_GLM_CODING_PLAN_KEY_FILE = $secretFile

    foreach ($name in $benchmarkEnvironment.Keys) {
        if (-not $savedEnvironment.ContainsKey($name)) {
            $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        }
        [Environment]::SetEnvironmentVariable($name, $benchmarkEnvironment[$name], "Process")
    }
    foreach ($name in (@($allProviderEnvironmentNames) + @(
        "EASY_CODE_GLM_API_KEY_FILE",
        "EASY_CODE_GLM_CODING_PLAN_API_KEY_FILE"
    ) | Sort-Object -Unique)) {
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }

    $composeOutput = @(& docker compose --project-name easy-code-preflight version 2>&1)
    $composeExitCode = $LASTEXITCODE
    $composeVersion = [regex]::Match(
        ($composeOutput -join "`n"),
        "(?<![0-9])([0-9]+)\.[0-9]+\.[0-9]+(?![0-9])"
    )
    if (
        $composeExitCode -ne 0 -or
        -not $composeVersion.Success -or
        [int]$composeVersion.Groups[1].Value -lt 2
    ) {
        throw "Docker Compose v2 is unavailable in the benchmark environment. Run easy-code benchmark swe-bench doctor."
    }

    Push-Location $repositoryRoot
    try {
    & $harborPath @harborArgs
        $commandExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
    }
    if (Test-Path -LiteralPath $secretDirectory) {
        Remove-Item -LiteralPath $secretDirectory -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $secretDirectory) {
        throw "Unable to remove the temporary GLM Coding Plan credential directory."
    }
}
exit $commandExitCode
