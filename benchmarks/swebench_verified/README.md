# EASY CODE on SWE-bench Verified Mini (50 tasks)

This directory connects a locally built EASY CODE package to Harbor's
containerized SWE-bench Verified tasks. The pinned set is the published
`MariusHobbhahn/swe-bench-verified-mini` (also referred to as the HAL mini
set): 25 Django issues and 25 Sphinx issues.

This is a useful, repeatable 50-task development benchmark. It is **not** an
official SWE-bench organization subset or leaderboard track, so report its
score as `SWE-bench Verified Mini (HAL, 50)` and do not compare it directly
with a full 500-task SWE-bench Verified score.

## Pinned inputs

`subset-50.json` is the source of truth. It records:

- community mini dataset revision
  `b316c349947c29963fce3f4a65967c9807a4b673` and Parquet SHA-256
  `f9ba19dea78884f1081355d2d8afb671899981f24180aa0c4c1aa14d2c23e855`;
- official `SWE-bench/SWE-bench_Verified` revision
  `78f471bf655a3137b2e8a75af1501690ec009ec3`;
- Harbor dataset digest
  `sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341`;
- evaluator `swebench==5.0.2`;
- task repository commit `3d07b464b7b311a0cbfb5ed5b2d8a3b96f84a33d`;
- the exact ordered 50 instance IDs.

The list is an exact ordered copy of the pinned published mini dataset. EASY
CODE does not claim that this community subset was sampled by its own random
algorithm. Every ID is also checked against the pinned official Verified
dataset.

## Requirements

- Windows 10/11 with Docker Desktop using the WSL 2 Linux-container backend.
- An x86-64 host. SWE-bench images are not uniformly portable to ARM.
- At least 16 GB RAM and 8 CPU cores are recommended.
- Allow at least 120 GB free for Docker images and benchmark artifacts.
- Python 3.12 or newer. The integrated setup command installs the pinned
  Harbor and evaluator versions into an isolated environment on F:.
- Node.js 20.11 or newer to build the local EASY CODE package.

Docker is required; EASY CODE's own process sandbox is not a replacement for
the repository-specific SWE-bench images and grading environment.

## Keep benchmark data on F:

A practical layout, created automatically by the integrated commands, is:

```text
F:\easy-code-bench\swe-bench-verified-50\
  cache\
  home\
  python\
  packages\
  jobs\
  tmp\
```

The runner defaults to this location for job results. Docker Desktop stores
images in its own Linux VM, so setting `--jobs-dir` is not sufficient to keep
large images off C:. In Docker Desktop, move the **disk image location** to an
F: directory before pulling the SWE-bench images. Restart Docker and run
`docker info` afterward to confirm that the engine is healthy.

If you independently keep local copies of the two pinned Parquet files, verify
them without network access:

```powershell
python .\benchmarks\swebench_verified\verify_manifest.py `
  --mini-parquet F:\easy-code-bench\swe-bench-verified-50\datasets\mini.parquet `
  --official-parquet F:\easy-code-bench\swe-bench-verified-50\datasets\verified.parquet
```

The verification utility requires `pyarrow`, which is normally present in a
SWE-bench evaluation environment.

## Integrated setup

Build EASY CODE, then create the pinned benchmark environment. When running
from a source checkout, replace `easy-code` below with `node dist/index.js` if
the package has not been installed globally.

```powershell
npm run build
easy-code config set glm-coding-plan.api-key
easy-code benchmark swe-bench setup
easy-code benchmark swe-bench doctor
```

`setup` installs `harbor==0.16.1` and `swebench==5.0.2` under the benchmark
root. `doctor` checks the Linux/x86-64 Docker engine, Docker Compose v2, pinned
tool versions, the exact dataset digest and 50-task manifest, F-drive storage,
and the GLM Coding Plan credential without printing it. Docker Desktop itself
must be installed separately. The runner keeps Docker Desktop's original CLI
configuration path so its Compose plugin remains discoverable while Harbor,
Python, npm, and model caches stay on F:. Runs also apply a fixed `4x` Harbor
Agent-setup timeout multiplier so a cold Node.js and EASY CODE installation is
not cut off by the default setup deadline.

## GLM Coding Plan credential handling

The integrated runner accepts only `GLM_CODING_PLAN_API_KEY`; otherwise it
reads the separate key already saved by
`easy-code config set glm-coding-plan.api-key` from the operating-system
credential store. It never reads `ZAI_API_KEY`, `GLM_API_KEY`,
`ZHIPUAI_API_KEY`, or the `glm.api-key` credential. Standard GLM and GLM Coding
Plan keys are intentionally not interchangeable.
Before Harbor starts, the launcher places the key in a random, ACL-protected
file under the F-drive benchmark root. Harbor receives only that path, not the
credential value. The temporary host file is removed when the run exits.

The lower-level `run.ps1` helper is retained for people invoking Harbor
directly. That helper accepts `GLM_CODING_PLAN_API_KEY` in its process
environment and applies the same file-staging boundary before starting Harbor:

```powershell
$secureKey = Read-Host "GLM Coding Plan API key" -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $env:GLM_CODING_PLAN_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
}
```

For each disposable task container, the adapter uploads the key as an
owner-only one-shot file. EASY CODE consumes and removes that file during
startup before its tool loop begins. The key is not included in per-command
environment metadata, and captured stdout/stderr is defensively redacted.

## Smoke test first

Inspect the exact Harbor arguments without building a package, reading the
credential, or spending API credits:

```powershell
easy-code benchmark swe-bench run --dry-run --limit 1 --run-id smoke
```

Then run one pinned task:

```powershell
easy-code benchmark swe-bench run --limit 1 --run-id glm-coding-plan-5.3-flash-smoke
```

The runner packs the current EASY CODE build into `packages\`, uploads that
exact archive to the task container, and writes Harbor artifacts to `jobs\`.
Use `easy-code benchmark swe-bench prepare` only when you want to create the
archive without starting a run.

The adapter runs the following fixed EASY CODE profile in `/testbed`:

```text
provider: glm-coding-plan
model: glm-5.3-flash
endpoint: https://open.bigmodel.cn/api/coding/paas/v4
mode: code
thinking effort: high
approval: safe, auto-approved
```

The provider, endpoint, and credential source are fixed for this benchmark.
There is no fallback to the standard GLM API or its key.

EASY CODE's per-task data directory is `/logs/agent/easy-code-data`, outside
`/testbed` and inside the Harbor job artifacts.
`EASY_CODE_OUTER_SANDBOX=harbor` tells EASY CODE that the disposable Harbor
container is the outer isolation boundary. Do not set that variable for normal
host use.

## Run all 50 tasks

Only start the full run after the smoke task creates a patch and receives a
valid grader result:

```powershell
easy-code benchmark swe-bench run --limit 50 --concurrency 1 `
  --run-id glm-coding-plan-5.3-flash-verified-mini-50 --confirm-full-run
```

The default concurrency is one. Increase it only after confirming your GLM
Coding Plan rate limit and Docker capacity, for example `--concurrency 4`.
Keep `--n-attempts 1` for benchmark reporting; silently retrying whole tasks
changes the evaluation protocol.

If you exported a temporary credential for the lower-level runner, remove it
from the shell afterward:

```powershell
Remove-Item Env:GLM_CODING_PLAN_API_KEY
```

The explicit confirmation prevents an accidental 50-task spend. Job logs,
patches, and grader results go to
`F:\easy-code-bench\swe-bench-verified-50\jobs` by default. Use `-DataRoot`
with the lower-level script or `--root` with the integrated command to choose
a different directory on F:.

## Filtering and reproducibility

Harbor's task names include an organization prefix. A valid exact filter is:

```text
--include-task-name swe-bench/django__django-11790
```

Both runners create one exact filter for every selected ID. Do not use an empty
filter or an unverified wildcard: some runner versions may interpret a filter
that matches nothing as an unfiltered dataset run. Keep the manifest, dataset
revisions, task commit, evaluator version, EASY CODE npm archive, provider
channel, endpoint, model name, and Harbor job configuration with every reported
result.

For each run, report at least resolved count/rate, per-instance status, total
model cost or tokens, wall-clock time, and the hashes/versions pinned above.
