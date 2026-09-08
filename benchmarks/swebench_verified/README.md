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

The adapter explicitly enables DAG and subagent creation inside each task
container via `EASY_CODE_ORCHESTRATION_ENABLED=true`. This does not change the
ordinary CLI default. Existing configured step, concurrency and shared token/
request budgets still apply; the isolated stagnation reviewer remains enabled.
Orchestration is included in checkpoint identity; use a new job for this profile
instead of resuming results from a different package/profile.

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
  cache\                         # Harbor/npm/Python plus the pinned ONNX model
  home\
  python\
  packages\
  jobs\
  checkpoints\
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
root and prepares the pinned multilingual ONNX embedding model (about 136 MB)
under `cache\easy-code\models`. Existing verified files are reused. `doctor`
checks every model asset by size and SHA-256 in addition to the Linux/x86-64
Docker engine, Docker Compose v2, pinned tool versions, the exact dataset digest
and 50-task manifest, F-drive storage, and the GLM Coding Plan credential without
printing it. Docker Desktop itself
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
It also verifies the F-drive embedding model before reading the API key. The
trusted adapter copies those already-verified local assets into each isolated
Trial's `/tmp/easy-code-cache` and verifies them again before EASY CODE starts;
Trial containers do not download a model from the public network, and the copy
is discarded with the container instead of being retained in Harbor logs. This
local transfer can add setup time, especially at high concurrency.
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

The Harbor environment keeps its trusted baseline network policy while the
adapter installs runtime dependencies and while the verifier installs and runs
its declared evaluation dependencies. During model-controlled EASY CODE
execution, Harbor temporarily switches the container to an outbound allowlist
containing only the pinned provider host (`open.bigmodel.cn`). Direct access to
GitHub, package registries, and other public hosts is blocked for the evaluated
agent. The inner command sandbox also denies all command networking, including
the provider host. Setup installs bubblewrap/socat/ripgrep and must pass
`easy-code sandbox doctor`; unsupported nested namespaces fail closed, never
falling back to host execution. Do not grant privileged Docker or host networking.
After a returned agent process, the adapter restores the verifier baseline only
when no command lease or cleanup quarantine remains. Timeout or unknown cleanup
keeps egress restricted. Prefer dependencies preinstalled in trusted setup;
missing agent-side dependencies never open an unrestricted networking exception.

EASY CODE's per-task data directory is `/logs/agent/easy-code-data`, outside
`/testbed` and inside the Harbor job artifacts.
`EASY_CODE_OUTER_SANDBOX=harbor` tells EASY CODE that the disposable Harbor
container is the outer isolation boundary; it does not disable the inner
command sandbox. Do not set that variable for normal host use.

The launcher-managed checkpoint and embedding-model paths are not added to the
Agent process environment inside the container. They do remain in Harbor's host
process environment, which Docker Compose inherits while expanding the pinned
task definition. The pinned Harbor dataset and its Compose configuration are
therefore part of the benchmark's trusted host boundary.

## Infrastructure retry and checkpoint recovery

The runner keeps `--n-attempts 1`, and permits one retry only when Harbor times
out before the Agent starts (environment start or Agent setup). Those failures
occur before `agent.run`, so the retry neither consumes a model request nor
creates or depends on a checkpoint from the failed setup attempt. Agent
timeouts and non-zero exits are intentionally not retried with a fresh time or
step budget.

Separately, once `agent.run` begins, its `finally` path captures the EASY CODE
data directory, the Git workspace patch, and regular untracked files into an
atomic generation below the launcher-managed `checkpoints\` directory. If an
interrupted Harbor job is explicitly resumed and recreates the matching task in
the same job scope, the adapter verifies the existing generation, restores the
workspace, finds exactly one resumable parent Thread, and asks EASY CODE to
continue it. The Thread journal remains authoritative; its own bounded
incremental checkpoint records reduce write amplification during a long run.

Recovery is deliberately per task, not per repository or batch. A checkpoint is
bound to the issue instruction, Harbor trial scope, base commit, package SHA-256,
embedding-model manifest SHA-256, provider endpoint identity, model, mode, and
thinking effort. The binding and
every captured file are integrity-checked; a mismatch, ambiguous parent Thread,
changed base commit, symlink, special file, or damaged manifest refuses recovery.
**A checkpoint is never restored into a
different SWE-bench task.** Do not copy checkpoint generations between task
directories or reuse them to seed another issue.

The newest valid generation is selected through an atomic pointer and up to
three recent generations are retained. Checkpoint capture is best-effort: a
capture error is recorded for diagnosis and cannot turn failed work into a
successful result. A present but invalid generation is rejected.

Each trial writes `easy-code-context-metrics.json` beside its other adapter logs
and also exposes the same object under Harbor metadata as `easyCodeBenchmark`.
Use these diagnostics to explain recovery and context behavior:

| Field | Meaning |
| --- | --- |
| `trialKey` | Hash of the exact recovery binding; compare for equality, but do not treat it as a task ID. |
| `checkpointGeneration` | Host generation captured at the end of this run, or null if none was committed. |
| `checkpointError` | Redacted capture/persistence error, or null. |
| `resumedFromCheckpoint` | Whether this run began from a verified matching generation. |
| `resumeThreadAvailable` | Whether exactly one parent Thread was available for future recovery. |
| `threadEventCount` | Non-empty records in the parent Thread's authoritative event journal. |
| `contextArtifactCount` | Indexed chunks of user, visible assistant, code-read, and tool evidence. Only chunks older than the active working-set boundary are eligible for a given retrieval. |
| `contextEmbeddingCount` | Context chunks with a compatible stored semantic vector. |
| `contextLexicalOnlyCount` | Indexed chunks currently lacking a stored semantic vector. |
| `contextCheckpointSequence` | Sequence of the derived Working Checkpoint, not the Thread journal sequence. |
| `contextIndexedMessageCount` | Durable messages consumed by the Thread-context index. |
| `contextCompactedMessageCount` | Messages covered by the cumulative working summary at capture time. |
| `retrievalBackend` | `hybrid` when semantic vectors are present, otherwise `fts5`; this describes available index state, not proof that a particular query used a vector hit. |
| `modelRequests` | Model requests recorded across the parent and child Thread journals. |
| `inputTokens` / `outputTokens` / `cachedInputTokens` | Provider-reported usage aggregated across those requests; absent provider fields remain zero rather than being estimated. |
| `metricsWarning` | Optional SQLite-read warning when metrics could not be collected completely. |

## Run all 50 tasks

Only start the full run after the smoke task creates a patch and receives a
valid grader result:

```powershell
easy-code benchmark swe-bench run --limit 50 --concurrency 1 `
  --run-id glm-coding-plan-5.3-flash-verified-mini-50 --confirm-full-run
```

To spread the same pinned 50 tasks across five Coding Plan quota windows, use
zero-based offsets with distinct job names:

```powershell
easy-code benchmark swe-bench run --offset 0  --limit 10 --concurrency 5 --run-id glm-cp-batch-1
easy-code benchmark swe-bench run --offset 10 --limit 10 --concurrency 5 --run-id glm-cp-batch-2
easy-code benchmark swe-bench run --offset 20 --limit 10 --concurrency 5 --run-id glm-cp-batch-3
easy-code benchmark swe-bench run --offset 30 --limit 10 --concurrency 5 --run-id glm-cp-batch-4
easy-code benchmark swe-bench run --offset 40 --limit 10 --concurrency 5 --run-id glm-cp-batch-5
```

These select manifest positions 1-10 through 41-50 without overlap. The
runner rejects offsets outside `0..49` and rejects a slice when
`offset + limit > 50`, so a typo cannot silently produce a partial final
batch. Keep each batch directory when reporting the combined 50-task result.

The default concurrency is one. Increase it only after confirming your GLM
Coding Plan rate limit and Docker capacity, for example `--concurrency 4`.
Keep `--n-attempts 1` for benchmark reporting. The configured retry is limited
to environment-start and Agent-setup timeouts, before a model request can run.
Agent timeouts, non-zero exits, increased attempts, or silently rerunning whole
tasks would change the evaluation protocol and are intentionally not retried.

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
model cost or tokens, wall-clock time, the hashes/versions pinned above, and the
per-instance checkpoint/context metrics. In particular, retain the trial key,
whether recovery occurred, any checkpoint or metrics warning, Thread event and
context-artifact counts, Working Checkpoint sequence, and retrieval backend.
