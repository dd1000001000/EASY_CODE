"""Harbor adapter for evaluating a local EASY CODE package on SWE-bench.

The adapter deliberately receives the npm package and provider credential from
the host launcher. It never downloads EASY CODE from a registry and never
places the GLM Coding Plan key in a shell command or log message.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import tomllib
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import NetworkMode, NetworkPolicy
from benchmarks.swebench_verified.split_environment import SplitBenchmarkEnvironment


_REMOTE_PACKAGE = "/tmp/easy-code-agent.tgz"
_REMOTE_DATA_DIR = "/logs/agent/easy-code-data"
_REMOTE_CACHE_DIR = "/tmp/easy-code-cache"
_REMOTE_MODEL_DIR = (
    f"{_REMOTE_CACHE_DIR}/models/paraphrase-multilingual-MiniLM-L12-v2"
)
_REMOTE_CHECKPOINT_STAGE = "/logs/agent/easy-code-checkpoint"
_REMOTE_SECRETS_DIR = "/tmp/easy-code-secrets"
_REMOTE_API_KEY_FILE = f"{_REMOTE_SECRETS_DIR}/provider-api-key"
_REMOTE_MODEL_REGISTRY = "/root/.easy_code/models.toml"
_TESTBED = "/testbed"
_CHECKPOINT_ROOT_ENV = "EASY_CODE_BENCHMARK_CHECKPOINT_ROOT"
_MODEL_DIRECTORY_ENV = "EASY_CODE_BENCHMARK_EMBEDDING_MODEL_DIR"
_CHECKPOINT_SCHEMA_VERSION = 1
_BENCHMARK_ORCHESTRATION_ENABLED = True
_MAX_CHECKPOINT_GENERATIONS = 3
_BENCHMARK_DATASET_REF = (
    "sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341"
)
_THREAD_ID_PATTERN = re.compile(
    r"^thread_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_GENERATION_PATTERN = re.compile(r"^[0-9a-f]{32}$")
_RESUME_INSTRUCTION = (
    "Continue the interrupted SWE-bench task from the restored EASY CODE "
    "checkpoint. Reinspect the current workspace changes, finish the requested "
    "fix, and run the relevant verification."
)
_MODEL_REGISTRY_PATH = Path(
    os.environ.get(
        "EASY_CODE_MODEL_REGISTRY_PATH",
        str(Path(__file__).resolve().parents[2] / "resources" / "models.default.toml"),
    )
).expanduser().resolve()


def _load_benchmark_profile() -> tuple[str, str, str, str, str, str]:
    """Load the benchmark profile from the exact user model registry."""

    try:
        catalog = tomllib.loads(_MODEL_REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise RuntimeError(
            f"Unable to load the EASY CODE model registry at {_MODEL_REGISTRY_PATH}."
        ) from error

    profile = catalog.get("profiles", {}).get("swe_bench_verified_50")
    if not isinstance(profile, dict):
        raise RuntimeError(
            "The EASY CODE model registry does not define profiles.swe_bench_verified_50."
        )

    required_profile_fields = ("model", "mode", "thinking_effort")
    if any(
        not isinstance(profile.get(field), str) or not profile[field].strip()
        for field in required_profile_fields
    ):
        raise RuntimeError("The SWE-bench model profile is incomplete.")

    model_alias = profile["model"].strip()
    model_entry = catalog.get("models", {}).get(model_alias)
    if not isinstance(model_entry, dict):
        raise RuntimeError(f"The SWE-bench model alias {model_alias!r} is absent from the model registry.")
    provider_id = str(model_entry.get("provider", "")).strip()
    providers = catalog.get("providers")
    if not isinstance(providers, dict):
        raise RuntimeError("The EASY CODE model registry has no provider table.")
    provider = providers.get(provider_id)
    if not isinstance(provider, dict):
        raise RuntimeError(
            f"The SWE-bench provider {provider_id!r} is absent from the model registry."
        )
    model_id = str(model_entry.get("model", "")).strip()
    if not model_id:
        raise RuntimeError(f"The SWE-bench model alias {model_alias!r} has no wire model id.")

    endpoint = provider.get("base_url")
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise RuntimeError("The SWE-bench provider has no default endpoint.")
    endpoint_parts = urlsplit(endpoint.strip())
    if endpoint_parts.scheme != "https" or not endpoint_parts.hostname:
        raise RuntimeError("The SWE-bench provider must use a valid HTTPS endpoint.")
    base_url_env = f"EASY_CODE_{re.sub(r'[^A-Za-z0-9]+', '_', provider_id).upper()}_BASE_URL"

    return (
        provider_id,
        model_id,
        profile["mode"].strip(),
        profile["thinking_effort"].strip(),
        endpoint.strip(),
        base_url_env,
    )


(
    _BENCHMARK_PROVIDER,
    _BENCHMARK_MODEL,
    _BENCHMARK_MODE,
    _BENCHMARK_THINKING_EFFORT,
    _BENCHMARK_BASE_URL,
    _BENCHMARK_BASE_URL_ENV,
) = _load_benchmark_profile()
_BENCHMARK_ALLOWED_HOST = urlsplit(_BENCHMARK_BASE_URL).hostname
if not _BENCHMARK_ALLOWED_HOST:
    raise RuntimeError("The SWE-bench provider endpoint has no hostname.")


def _benchmark_agent_network_policy() -> NetworkPolicy:
    """Allow the evaluated agent to reach only its pinned model endpoint."""

    return NetworkPolicy(
        network_mode=NetworkMode.ALLOWLIST,
        allowed_hosts=[_BENCHMARK_ALLOWED_HOST],
    )


def _validate_private_ipc(info: dict[str, Any]) -> None:
    """The container, not an individual command, owns the bounded IPC pool."""
    size = info.get("shmBytes")
    if (info.get("ipc") != "private" or info.get("privileged") is not False
            or type(size) is not int or not 0 < size <= 256 * 1024 * 1024
            or not isinstance(info.get("mounts"), list)):
        raise RuntimeError("Harbor requires private Docker IPC, non-privileged mode and bounded /dev/shm (at most 256 MiB).")
    for mount in info["mounts"]:
        destination = mount.get("Destination") if isinstance(mount, dict) else None
        if not isinstance(destination, str):
            raise RuntimeError("Unable to verify Harbor shared-memory mounts.")
        destination = destination.rstrip("/") or "/"
        if destination in ("/", "/dev", "/dev/shm") or destination.startswith("/dev/shm/"):
            raise RuntimeError("Harbor forbids external or nested /dev/shm mounts.")


class EasyCodeBenchmarkDockerEnvironment(DockerEnvironment):
    """Prepare Harbor's egress controller for restricted agent execution.

    Published SWE-bench tasks start with public networking so the trusted
    adapter can install runtime dependencies. Declaring the provider allowlist
    as a possible phase policy makes Harbor create its egress-control sidecar
    at startup. ``EasyCodeAgent.run`` activates it before model-controlled code
    runs and restores Harbor's trusted baseline policy when that code exits so
    the verifier can install its declared dependencies.
    """

    async def assert_private_ipc(self) -> None:
        result = await self._run_docker_compose_command(["ps", "-q", "main"], timeout_sec=30)
        container_id = str(result.stdout or "").strip()
        if not re.fullmatch(r"[0-9a-f]{12,64}", container_id):
            raise RuntimeError("Unable to identify the Harbor main container for IPC verification.")
        projection = ('{"ipc":{{json .HostConfig.IpcMode}},"shmBytes":{{json .HostConfig.ShmSize}},'
                      '"privileged":{{json .HostConfig.Privileged}},"mounts":{{json .Mounts}}}')
        inspected = await asyncio.to_thread(subprocess.run,
            ["docker", "inspect", "--format", projection, container_id],
            capture_output=True, text=True, timeout=30, check=True)
        _validate_private_ipc(json.loads(inspected.stdout))

    def __init__(
        self,
        *args: Any,
        phase_network_policies: Sequence[NetworkPolicy] = (),
        **kwargs: Any,
    ) -> None:
        restricted_policy = _benchmark_agent_network_policy()
        policies = [*phase_network_policies]
        if restricted_policy not in policies:
            policies.append(restricted_policy)
        super().__init__(
            *args,
            phase_network_policies=policies,
            **kwargs,
        )


class EasyCodeAgent(BaseInstalledAgent):
    """Run EASY CODE inside Harbor's disposable SWE-bench environment."""

    @staticmethod
    def name() -> str:
        return "easy-code"

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)

        package_value = os.environ.get("EASY_CODE_PACKAGE_PATH", "").strip()
        if not package_value:
            raise RuntimeError(
                "EASY_CODE_PACKAGE_PATH must point to a locally built npm .tgz package."
            )
        package_path = Path(package_value).expanduser().resolve()
        if not package_path.is_file() or package_path.suffix.lower() != ".tgz":
            raise RuntimeError(
                "EASY_CODE_PACKAGE_PATH must point to an existing npm .tgz package."
            )

        api_key_file_value = os.environ.get("EASY_CODE_PROVIDER_KEY_FILE", "").strip()
        if not api_key_file_value:
            raise RuntimeError(
                "EASY_CODE_PROVIDER_KEY_FILE must identify the launcher's private key file."
            )
        api_key_file = Path(api_key_file_value).resolve()
        if not api_key_file.is_file():
            raise RuntimeError(
                "The staged provider credential file is unavailable."
            )
        api_key = api_key_file.read_text(encoding="utf-8").strip()
        if not api_key or len(api_key.encode("utf-8")) > 16_384:
            raise RuntimeError(
                "The staged provider credential has an invalid size."
            )

        self._package_path = package_path
        if not _MODEL_REGISTRY_PATH.is_file():
            raise RuntimeError("The frozen EASY CODE model registry is unavailable.")
        self._model_registry_path = _MODEL_REGISTRY_PATH
        self._package_sha256 = self._sha256_file(package_path)
        model_directory_value = os.environ.get(_MODEL_DIRECTORY_ENV, "").strip()
        if not model_directory_value:
            raise RuntimeError(
                f"{_MODEL_DIRECTORY_ENV} must identify the verified host embedding model."
            )
        model_directory = Path(model_directory_value).expanduser().resolve()
        if not model_directory.is_dir():
            raise RuntimeError(
                "The benchmark embedding model is unavailable; rerun benchmark setup."
            )
        self._assert_regular_tree(model_directory)
        model_manifest = model_directory / "manifest.json"
        if not model_manifest.is_file():
            raise RuntimeError("The benchmark embedding model manifest is missing.")
        self._model_directory = model_directory
        self._model_manifest_sha256 = self._sha256_file(model_manifest)
        self._host_api_key_file = api_key_file
        self._api_key = api_key
        self._adapter_logs_dir = Path(logs_dir).resolve()

        checkpoint_root_value = os.environ.get(_CHECKPOINT_ROOT_ENV, "").strip()
        if not checkpoint_root_value:
            raise RuntimeError(
                f"{_CHECKPOINT_ROOT_ENV} must identify the launcher-managed checkpoint root."
            )
        checkpoint_root = Path(checkpoint_root_value).expanduser().resolve()
        checkpoint_root.mkdir(parents=True, exist_ok=True)
        if not checkpoint_root.is_dir():
            raise RuntimeError("The SWE-bench checkpoint root is not a directory.")
        self._checkpoint_root = checkpoint_root
        # Immediate retries retain the TrialConfig while a resumed Harbor job
        # may recreate an unfinished trial with a new random suffix. Bind to
        # the stable job directory, then add the issue and repository hashes.
        self._job_scope_hash = self._sha256_text(
            str(self._adapter_logs_dir.parents[1])
        )

    async def install(self, environment: BaseEnvironment) -> None:
        """Install Node and the exact locally packed EASY CODE build."""

        if not isinstance(environment, EasyCodeBenchmarkDockerEnvironment):
            raise RuntimeError("EASY CODE requires the trusted Harbor Docker environment with managed egress.")
        await environment.assert_private_ipc()

        # Harbor 0.16.1 does not expose a system-dependency helper. Keep this
        # distro-aware bootstrap aligned with its built-in installed agents.
        await self.exec_as_root(
            environment,
            command=(
                "if [ -f /etc/alpine-release ]; then"
                "  apk add --no-cache bash ca-certificates curl git nodejs npm ripgrep gcc musl-dev linux-headers;"
                " elif command -v apt-get >/dev/null 2>&1; then"
                "  apt-get update && DEBIAN_FRONTEND=noninteractive "
                "apt-get install -y ca-certificates curl git ripgrep gcc libc6-dev linux-libc-dev;"
                " elif command -v yum >/dev/null 2>&1; then"
                "  yum install -y ca-certificates curl git ripgrep gcc glibc-devel kernel-headers;"
                " else"
                '  echo "No supported package manager was found" >&2; exit 1;'
                " fi"
            ),
            timeout_sec=600,
        )
        await environment.upload_file(self._package_path, _REMOTE_PACKAGE)
        # Harbor 0.16.1's Docker upload first tries `docker compose cp`. Its
        # in-memory tar fallback is expensive for the 136 MB model and is used
        # when the destination parent does not exist, so create the exact
        # destination before transferring the verified assets.
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {shlex.quote(_REMOTE_MODEL_DIR)}",
            timeout_sec=30,
        )
        await environment.upload_dir(self._model_directory, _REMOTE_MODEL_DIR)
        await self.exec_as_root(
            environment,
            command=f"chmod -R a+rX {shlex.quote(_REMOTE_MODEL_DIR)}",
            timeout_sec=30,
        )

        install_script = f"""
set -euo pipefail
if [ ! -f /etc/alpine-release ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm alias default 22
fi
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 20 || (major === 20 && minor < 11)) process.exit(1)'
npm install --global --ignore-scripts {shlex.quote(_REMOTE_PACKAGE)}
export EASY_CODE_CACHE_DIR={shlex.quote(_REMOTE_CACHE_DIR)}
global_root="$(npm root --global)"
test -f "$global_root/easy-code-agent/dist/sandbox/benchmark-backend.js" || {{ echo "This adapter requires the split-container EASY CODE build; rebuild and repack the supplied npm archive." >&2; exit 78; }}
node "$global_root/easy-code-agent/scripts/embedding-model.cjs" verify
easy-code --version
echo 'EASY CODE controller installed; offline task container isolation is verified by the host adapter before execution.'
""".strip()

        result = await self.exec_as_root(
            environment,
            command=self._bash(install_script),
            timeout_sec=600,
        )
        self._record_output("install.log", result)
        self._require_success("EASY CODE installation", result)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Give one isolated SWE-bench issue to EASY CODE and retain its state."""

        if not isinstance(environment, EasyCodeBenchmarkDockerEnvironment):
            raise RuntimeError("Harbor outer isolation requires the managed Docker environment.")

        workspace_base_commit = await self._workspace_base_commit(environment)
        binding = self._trial_binding(instruction, workspace_base_commit)
        restored = self._prepare_trial(binding)
        resume_thread_id = self._discover_parent_thread_id() if restored else None
        if restored and resume_thread_id is None:
            raise RuntimeError(
                "The restored benchmark checkpoint has no resumable parent Thread."
            )
        if restored:
            await self._restore_workspace(environment)

        original_environment = environment
        split_environment = await SplitBenchmarkEnvironment.create(environment)
        environment = split_environment
        workspace_exported = False

        command_parts = [
            "easy-code",
            "--workspace",
            shlex.quote(_TESTBED),
        ]
        if resume_thread_id is not None:
            command_parts.extend(("--resume", shlex.quote(resume_thread_id)))
        command_parts.extend(
            (
                "--provider",
                shlex.quote(_BENCHMARK_PROVIDER),
                "--model",
                shlex.quote(_BENCHMARK_MODEL),
                "--mode",
                shlex.quote(_BENCHMARK_MODE),
                "--thinking-effort",
                shlex.quote(_BENCHMARK_THINKING_EFFORT),
                "--approval",
                "safe",
                "--yes",
                "run",
                shlex.quote(_RESUME_INSTRUCTION if restored else instruction),
            )
        )
        easy_code_command = " ".join(command_parts)
        run_script = "\n".join(
            (
                "set -euo pipefail",
                'export NVM_DIR="$HOME/.nvm"',
                'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi',
                'command -v node >/dev/null 2>&1 || { echo "Node runtime is unavailable" >&2; exit 1; }',
                'command -v easy-code >/dev/null 2>&1 || { echo "EASY CODE is unavailable" >&2; exit 1; }',
                easy_code_command,
            )
        )

        # The runtime receives only the path to an owner-only one-shot secret.
        # EASY CODE consumes and unlinks it before the tool loop begins, so the
        # provider credential is absent from both Harbor's per-command env logs
        # and the environment inherited by model-controlled child processes.
        result: Any | None = None
        checkpoint_generation: str | None = None
        checkpoint_error: str | None = None
        capture_succeeded = False
        try:
            try:
                baseline_network_policy = environment.network_policy
                await self._stage_api_key(environment)
                await self._stage_model_registry(environment)
                await environment.set_network_policy(
                    _benchmark_agent_network_policy()
                )
                try:
                    result = await environment.exec(
                        command=self._bash(run_script),
                        user="root",
                        cwd=_TESTBED,
                        env={
                            "EASY_CODE_PROVIDER_API_KEY_FILE": _REMOTE_API_KEY_FILE,
                            _BENCHMARK_BASE_URL_ENV: _BENCHMARK_BASE_URL,
                            "EASY_CODE_DATA_DIR": _REMOTE_DATA_DIR,
                            "EASY_CODE_CACHE_DIR": _REMOTE_CACHE_DIR,
                            "EASY_CODE_OUTER_SANDBOX": "harbor",
                            "EASY_CODE_ORCHESTRATION_ENABLED": str(
                                _BENCHMARK_ORCHESTRATION_ENABLED
                            ).lower(),
                            "EASY_CODE_SUBAGENT_ISOLATION": "shared",
                            "CI": "1",
                            "NO_COLOR": "1",
                        },
                        timeout_sec=3600,
                    )
                finally:
                    # A returned root process is not sufficient: all command
                    # leases must have closed and no cleanup quarantine may
                    # remain. On timeout/uncertainty keep egress restricted.
                    if result is not None:
                        exit_code = getattr(result, "return_code", getattr(result, "exit_code", None))
                        if not isinstance(exit_code, int):
                            raise RuntimeError("Agent exit is unknown; verifier networking stays restricted.")
                        await split_environment.export_workspace()
                        workspace_exported = True
                        await self._restore_network_after_clean_exit(
                            environment, baseline_network_policy
                        )
                self._record_output("easy-code.log", result)
                if result is None:
                    raise RuntimeError(
                        "EASY CODE benchmark run produced no process result."
                    )
                # Classify and redact a non-zero result while the one in-memory
                # credential copy is still available to the adapter.
                self._require_success("EASY CODE benchmark run", result)
            finally:
                try:
                    if not workspace_exported:
                        await split_environment.export_workspace()
                        workspace_exported = True
                    await self._capture_workspace(
                        original_environment, workspace_base_commit
                    )
                    capture_succeeded = True
                except Exception as capture_error:
                    checkpoint_error = self._redact(str(capture_error))
                    self.logger.warning(
                        "Failed to capture the SWE-bench workspace checkpoint: %s",
                        checkpoint_error,
                    )
                if capture_succeeded:
                    try:
                        checkpoint_generation = self._persist_checkpoint(binding)
                    except Exception as persist_error:
                        checkpoint_error = self._redact(str(persist_error))
                        self.logger.warning(
                            "Failed to persist the SWE-bench checkpoint: %s",
                            checkpoint_error,
                        )

                try:
                    parent_thread_id = self._discover_parent_thread_id()
                    metrics = self._collect_context_metrics(parent_thread_id)
                    usage = self._collect_model_usage()
                    metrics.update(usage)
                    if usage["reportedInputRequests"] > 0:
                        context.n_input_tokens = usage["inputTokens"]
                    if usage["reportedOutputRequests"] > 0:
                        context.n_output_tokens = usage["outputTokens"]
                    if usage["reportedCacheRequests"] > 0:
                        context.n_cache_tokens = usage["cachedInputTokens"]
                    context.cost_usd = None
                    metrics.update(
                        {
                            "checkpointGeneration": checkpoint_generation,
                            "checkpointError": checkpoint_error,
                            "resumedFromCheckpoint": restored,
                            "resumeThreadAvailable": parent_thread_id is not None,
                            "trialKey": binding["trialKey"],
                        }
                    )
                    self._write_json_atomic(
                        self._adapter_logs_dir
                        / "easy-code-context-metrics.json",
                        metrics,
                    )
                    context.metadata = {
                        **(context.metadata or {}),
                        "easyCodeBenchmark": metrics,
                    }
                except Exception as metrics_error:
                    self.logger.warning(
                        "Failed to collect SWE-bench context metrics: %s",
                        self._redact(str(metrics_error)),
                    )
        finally:
            try:
                await self.exec_as_root(
                    environment,
                    command=f"rm -rf {shlex.quote(_REMOTE_SECRETS_DIR)}",
                    timeout_sec=30,
                )
            except Exception as cleanup_error:
                self.logger.warning(
                    "Failed to remove the remote EASY CODE credential directory: %s",
                    cleanup_error,
                )
            finally:
                self._api_key = ""
                await split_environment.close()

    def _trial_binding(
        self, instruction: str, workspace_base_commit: str
    ) -> dict[str, Any]:
        if not re.fullmatch(r"[0-9a-f]{40}", workspace_base_commit):
            raise RuntimeError("The SWE-bench workspace base commit is invalid.")
        identity: dict[str, Any] = {
            "schemaVersion": _CHECKPOINT_SCHEMA_VERSION,
            "datasetRef": _BENCHMARK_DATASET_REF,
            "instructionSha256": self._sha256_text(instruction),
            "jobScopeSha256": self._job_scope_hash,
            "workspaceBaseCommit": workspace_base_commit,
            "packageSha256": self._package_sha256,
            "embeddingModelManifestSha256": self._model_manifest_sha256,
            "provider": _BENCHMARK_PROVIDER,
            "model": _BENCHMARK_MODEL,
            "mode": _BENCHMARK_MODE,
            "thinkingEffort": _BENCHMARK_THINKING_EFFORT,
            "orchestrationEnabled": _BENCHMARK_ORCHESTRATION_ENABLED,
            "endpointSha256": self._sha256_text(_BENCHMARK_BASE_URL),
        }
        canonical = json.dumps(
            identity, ensure_ascii=True, sort_keys=True, separators=(",", ":")
        )
        return {**identity, "trialKey": self._sha256_text(canonical)}

    async def _workspace_base_commit(
        self, environment: BaseEnvironment
    ) -> str:
        result = await self.exec_as_agent(
            environment,
            command=self._bash(
                f"git -C {shlex.quote(_TESTBED)} rev-parse --verify HEAD"
            ),
            timeout_sec=30,
        )
        commit = str(getattr(result, "stdout", "") or "").strip()
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise RuntimeError("Unable to identify the SWE-bench base commit.")
        return commit

    def _prepare_trial(self, binding: dict[str, Any]) -> bool:
        """Restore only the generation cryptographically bound to this trial."""

        local_stage = self._adapter_logs_dir / "easy-code-checkpoint"
        local_data = self._adapter_logs_dir / "easy-code-data"
        local_binding = local_stage / "binding.json"
        if local_data.exists():
            if not local_binding.is_file():
                raise RuntimeError(
                    "Existing benchmark state has no binding; refusing unsafe reuse."
                )
            self._require_binding(local_binding, binding)
            if not local_data.is_dir():
                raise RuntimeError("Existing benchmark data is not a directory.")
            self._prepare_restored_data(local_data)
            return True
        if local_binding.exists():
            self._require_binding(local_binding, binding)

        checkpoint_dir = self._checkpoint_directory(binding)
        binding_path = checkpoint_dir / "binding.json"
        latest_path = checkpoint_dir / "latest.json"
        if not latest_path.exists():
            if binding_path.exists():
                self._require_binding(binding_path, binding)
            local_stage.mkdir(parents=True, exist_ok=True)
            self._write_json_atomic(local_binding, binding)
            return False
        self._require_binding(binding_path, binding)
        latest = self._read_json_object(latest_path)
        generation = latest.get("generation")
        if not isinstance(generation, str) or not _GENERATION_PATTERN.fullmatch(
            generation
        ):
            raise RuntimeError("The benchmark checkpoint pointer is invalid.")
        generation_dir = checkpoint_dir / "g" / generation
        self._verify_generation(generation_dir, binding)
        shutil.copytree(generation_dir / "d", local_data)
        local_stage.mkdir(parents=True, exist_ok=True)
        for name in (
            "binding.json",
            "workspace.base",
            "workspace.json",
            "workspace.patch",
            "untracked.tar.gz",
            "easy-code-refs.tsv",
            "easy-code-refs.bundle",
        ):
            source = generation_dir / name
            if source.is_file():
                shutil.copy2(source, local_stage / name)
        self._require_binding(local_binding, binding)
        self._prepare_restored_data(local_data)
        return True

    async def _restore_workspace(self, environment: BaseEnvironment) -> None:
        script = f"""
set -euo pipefail
stage={shlex.quote(_REMOTE_CHECKPOINT_STAGE)}
testbed={shlex.quote(_TESTBED)}
metadata="$stage/workspace.json"
[ -f "$metadata" ] || {{ echo "Missing workspace checkpoint metadata" >&2; exit 71; }}
expected="$(cat "$stage/workspace.base")"
printf '%s' "$expected" | grep -Eq '^[0-9a-f]{{40}}$' || {{ echo "Invalid workspace checkpoint metadata" >&2; exit 72; }}
actual="$(git -C "$testbed" rev-parse HEAD)"
[ "$actual" = "$expected" ] || {{ echo "Workspace base commit does not match checkpoint" >&2; exit 73; }}
[ -z "$(git -C "$testbed" status --porcelain=v1 --untracked-files=all)" ] || {{ echo "Fresh benchmark workspace is not clean" >&2; exit 74; }}
refs_file="$stage/easy-code-refs.tsv"
refs_bundle="$stage/easy-code-refs.bundle"
if [ -f "$refs_bundle" ] && [ ! -s "$refs_file" ]; then
  echo "Checkpoint Git bundle has no reference manifest" >&2
  exit 77
fi
if [ -s "$refs_file" ]; then
  if [ -f "$refs_bundle" ]; then
    git -C "$testbed" bundle verify "$refs_bundle" >/dev/null
    git -C "$testbed" bundle unbundle "$refs_bundle" >/dev/null
  fi
  while IFS=$'\t' read -r oid ref extra; do
    [ -z "$extra" ] || {{ echo "Invalid checkpoint Git reference record" >&2; exit 78; }}
    printf '%s' "$oid" | grep -Eq '^[0-9a-f]{{40}}$' || {{ echo "Invalid checkpoint Git object" >&2; exit 78; }}
    printf '%s' "$ref" | grep -Eq '^refs/easy-code/environments/[A-Za-z0-9._-]{{1,160}}/(baseline|result)$' || {{ echo "Invalid checkpoint Git reference" >&2; exit 78; }}
    git -C "$testbed" cat-file -e "$oid^{{commit}}" || {{ echo "Checkpoint Git object is missing" >&2; exit 79; }}
    current="$(git -C "$testbed" rev-parse --verify "$ref" 2>/dev/null || true)"
    [ -z "$current" ] || [ "$current" = "$oid" ] || {{ echo "Checkpoint Git reference conflicts with the fresh repository" >&2; exit 80; }}
    git -C "$testbed" update-ref "$ref" "$oid"
  done < "$refs_file"
fi
git -C "$testbed" worktree prune --expire now
if [ -s "$stage/workspace.patch" ]; then
  git -C "$testbed" apply --binary --whitespace=nowarn "$stage/workspace.patch"
fi
if [ -f "$stage/untracked.tar.gz" ]; then
  tar -C "$testbed" --keep-old-files --no-same-owner --no-same-permissions -xzf "$stage/untracked.tar.gz"
fi
""".strip()
        result = await self.exec_as_agent(
            environment,
            command=self._bash(script),
            timeout_sec=180,
        )
        self._record_output("checkpoint-restore.log", result)
        self._require_success("SWE-bench checkpoint workspace restore", result)

    async def _capture_workspace(
        self, environment: BaseEnvironment, workspace_base_commit: str
    ) -> None:
        script = f"""
set -euo pipefail
stage={shlex.quote(_REMOTE_CHECKPOINT_STAGE)}
testbed={shlex.quote(_TESTBED)}
base={shlex.quote(workspace_base_commit)}
mkdir -p "$stage"
git -C "$testbed" cat-file -e "$base^{{commit}}"
git -C "$testbed" diff --binary --full-index --no-ext-diff "$base" -- > "$stage/workspace.patch.tmp"
mv "$stage/workspace.patch.tmp" "$stage/workspace.patch"
git -C "$testbed" diff --name-only -z "$base" -- > "$stage/changed.list"
while IFS= read -r -d '' item; do
  [ ! -L "$testbed/$item" ] || {{ echo "Changed symlinks cannot be checkpointed" >&2; exit 75; }}
done < "$stage/changed.list"
git -C "$testbed" ls-files --others --exclude-standard -z > "$stage/untracked.list"
while IFS= read -r -d '' item; do
  [ -f "$testbed/$item" ] && [ ! -L "$testbed/$item" ] || {{ echo "Only regular untracked files can be checkpointed" >&2; exit 76; }}
done < "$stage/untracked.list"
rm -f "$stage/untracked.tar.gz"
if [ -s "$stage/untracked.list" ]; then
  tar -C "$testbed" --null --files-from="$stage/untracked.list" -czf "$stage/untracked.tar.gz.tmp"
  mv "$stage/untracked.tar.gz.tmp" "$stage/untracked.tar.gz"
fi
rm -f "$stage/easy-code-refs.tsv" "$stage/easy-code-refs.bundle" "$stage/easy-code-refs.bundle.tmp"
git -C "$testbed" for-each-ref --format='%(objectname)%09%(refname)' refs/easy-code/environments/ > "$stage/easy-code-refs.tsv.tmp"
while IFS=$'\t' read -r oid ref extra; do
  [ -z "$extra" ] || {{ echo "Invalid EASY CODE Git reference record" >&2; exit 77; }}
  printf '%s' "$oid" | grep -Eq '^[0-9a-f]{{40}}$' || {{ echo "Invalid EASY CODE Git object" >&2; exit 77; }}
  printf '%s' "$ref" | grep -Eq '^refs/easy-code/environments/[A-Za-z0-9._-]{{1,160}}/(baseline|result)$' || {{ echo "Invalid EASY CODE Git reference" >&2; exit 77; }}
done < "$stage/easy-code-refs.tsv.tmp"
if [ -s "$stage/easy-code-refs.tsv.tmp" ]; then
  mv "$stage/easy-code-refs.tsv.tmp" "$stage/easy-code-refs.tsv"
  mapfile -t easy_code_refs < <(cut -f2 "$stage/easy-code-refs.tsv")
  new_commit_count="$(git -C "$testbed" rev-list --count "${{easy_code_refs[@]}}" --not "$base")"
  if [ "$new_commit_count" -gt 0 ]; then
    git -C "$testbed" bundle create "$stage/easy-code-refs.bundle.tmp" "${{easy_code_refs[@]}}" "^$base"
    mv "$stage/easy-code-refs.bundle.tmp" "$stage/easy-code-refs.bundle"
  fi
else
  rm -f "$stage/easy-code-refs.tsv.tmp"
fi
printf '{{\"baseCommit\":\"%s\",\"schemaVersion\":%s}}\n' "$base" "{_CHECKPOINT_SCHEMA_VERSION}" > "$stage/workspace.json.tmp"
mv "$stage/workspace.json.tmp" "$stage/workspace.json"
printf '%s\n' "$base" > "$stage/workspace.base.tmp"
mv "$stage/workspace.base.tmp" "$stage/workspace.base"
rm -f "$stage/changed.list" "$stage/untracked.list"
""".strip()
        result = await self.exec_as_agent(
            environment,
            command=self._bash(script),
            timeout_sec=180,
        )
        self._record_output("checkpoint-capture.log", result)
        self._require_success("SWE-bench checkpoint workspace capture", result)

    def _persist_checkpoint(self, binding: dict[str, Any]) -> str | None:
        data_dir = self._adapter_logs_dir / "easy-code-data"
        stage_dir = self._adapter_logs_dir / "easy-code-checkpoint"
        if not data_dir.is_dir() or not (stage_dir / "workspace.json").is_file():
            return None
        self._require_binding(stage_dir / "binding.json", binding)
        self._assert_regular_tree(data_dir, excluded_top_level={"worktrees"})
        checkpoint_dir = self._checkpoint_directory(binding)
        generations_dir = checkpoint_dir / "g"
        generations_dir.mkdir(parents=True, exist_ok=True)
        binding_path = checkpoint_dir / "binding.json"
        if binding_path.exists():
            self._require_binding(binding_path, binding)
        else:
            self._write_json_atomic(binding_path, binding)

        generation = uuid.uuid4().hex
        staging = generations_dir / f"s-{generation}"
        final = generations_dir / generation
        staging.mkdir(parents=False, exist_ok=False)
        try:
            shutil.copytree(
                data_dir,
                staging / "d",
                ignore=lambda directory, names: self._checkpoint_copy_ignores(
                    data_dir, Path(directory), names
                ),
            )
            for name in (
                "binding.json",
                "workspace.base",
                "workspace.json",
                "workspace.patch",
                "untracked.tar.gz",
                "easy-code-refs.tsv",
                "easy-code-refs.bundle",
            ):
                source = stage_dir / name
                if source.is_file():
                    shutil.copy2(source, staging / name)
            manifest = {
                "schemaVersion": _CHECKPOINT_SCHEMA_VERSION,
                "generation": generation,
                "trialKey": binding["trialKey"],
                "files": self._file_manifest(staging),
            }
            self._write_json_atomic(staging / "manifest.json", manifest)
            staging.replace(final)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        self._write_json_atomic(
            checkpoint_dir / "latest.json",
            {"schemaVersion": _CHECKPOINT_SCHEMA_VERSION, "generation": generation},
        )
        self._prune_generations(generations_dir, generation)
        return generation

    def _verify_generation(
        self, generation_dir: Path, binding: dict[str, Any]
    ) -> None:
        if not generation_dir.is_dir():
            raise RuntimeError("The selected benchmark checkpoint is missing.")
        self._assert_regular_tree(generation_dir)
        self._require_binding(generation_dir / "binding.json", binding)
        manifest = self._read_json_object(generation_dir / "manifest.json")
        if (
            manifest.get("schemaVersion") != _CHECKPOINT_SCHEMA_VERSION
            or manifest.get("generation") != generation_dir.name
            or manifest.get("trialKey") != binding["trialKey"]
        ):
            raise RuntimeError("The checkpoint manifest belongs to another trial.")
        expected_files = manifest.get("files")
        if not isinstance(expected_files, dict):
            raise RuntimeError("The checkpoint file manifest is invalid.")
        actual_files = self._file_manifest(
            generation_dir, excluded={"manifest.json"}
        )
        if actual_files != expected_files:
            raise RuntimeError("The benchmark checkpoint failed integrity validation.")

    def _discover_parent_thread_id(self) -> str | None:
        threads_dir = self._adapter_logs_dir / "easy-code-data" / "threads"
        if not threads_dir.is_dir():
            return None
        parents: list[str] = []
        for directory in sorted(threads_dir.iterdir(), key=lambda item: item.name):
            if not directory.is_dir() or not _THREAD_ID_PATTERN.fullmatch(directory.name):
                continue
            journal = directory / "events.jsonl"
            if not journal.is_file():
                continue
            is_child = False
            with journal.open("rb") as handle:
                for line in handle:
                    try:
                        event = json.loads(line)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
                    if event.get("type") == "subagent.session_bound":
                        is_child = True
                        break
            if not is_child:
                parents.append(directory.name)
        if len(parents) > 1:
            raise RuntimeError(
                "The benchmark checkpoint contains multiple parent Threads; refusing ambiguous resume."
            )
        return parents[0] if parents else None

    def _collect_context_metrics(self, thread_id: str | None) -> dict[str, Any]:
        metrics: dict[str, Any] = {
            "threadEventCount": 0,
            "contextArtifactCount": 0,
            "contextEmbeddingCount": 0,
            "contextLexicalOnlyCount": 0,
            "contextCheckpointSequence": 0,
            "contextIndexedMessageCount": 0,
            "contextCompactedMessageCount": 0,
            "retrievalBackend": "fts5",
        }
        if thread_id is None:
            return metrics
        journal = (
            self._adapter_logs_dir
            / "easy-code-data"
            / "threads"
            / thread_id
            / "events.jsonl"
        )
        if journal.is_file():
            with journal.open("rb") as handle:
                metrics["threadEventCount"] = sum(1 for line in handle if line.strip())

        database_path = self._adapter_logs_dir / "easy-code-data" / "easy-code.db"
        if not database_path.is_file():
            return metrics
        try:
            connection = sqlite3.connect(
                f"file:{database_path.as_posix()}?mode=ro", uri=True, timeout=5
            )
            try:
                artifact_count = self._query_scalar(
                    connection,
                    "SELECT COUNT(*) FROM context_artifacts WHERE thread_id = ?",
                    (thread_id,),
                )
                embedding_count = self._query_scalar(
                    connection,
                    "SELECT COUNT(*) FROM context_artifact_embeddings WHERE thread_id = ?",
                    (thread_id,),
                )
                row = connection.execute(
                    "SELECT checkpoint_sequence, indexed_message_count, "
                    "compacted_message_count FROM context_checkpoints WHERE thread_id = ?",
                    (thread_id,),
                ).fetchone()
            finally:
                connection.close()
            metrics["contextArtifactCount"] = artifact_count
            metrics["contextEmbeddingCount"] = embedding_count
            metrics["contextLexicalOnlyCount"] = max(
                0, artifact_count - embedding_count
            )
            metrics["retrievalBackend"] = (
                "hybrid" if embedding_count > 0 else "fts5"
            )
            if row is not None:
                metrics["contextCheckpointSequence"] = int(row[0])
                metrics["contextIndexedMessageCount"] = int(row[1])
                metrics["contextCompactedMessageCount"] = int(row[2])
        except sqlite3.Error as error:
            metrics["metricsWarning"] = f"SQLite metrics unavailable: {error}"
        return metrics

    def _collect_model_usage(self) -> dict[str, int]:
        totals = {
            "modelRequests": 0,
            "reportedInputRequests": 0,
            "reportedOutputRequests": 0,
            "reportedCacheRequests": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "cachedInputTokens": 0,
        }
        threads_dir = self._adapter_logs_dir / "easy-code-data" / "threads"
        if not threads_dir.is_dir():
            return totals
        for journal in sorted(threads_dir.glob("*/events.jsonl")):
            if not journal.is_file() or journal.is_symlink():
                continue
            with journal.open("rb") as handle:
                for line in handle:
                    try:
                        event = json.loads(line)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
                    if (
                        event.get("type") != "model.usage"
                        or event.get("phase") != "completed"
                    ):
                        continue
                    payload = event.get("payload")
                    usage = payload.get("usage") if isinstance(payload, dict) else None
                    totals["modelRequests"] += 1
                    if not isinstance(usage, dict):
                        continue
                    for source, total, reported in (
                        ("promptTokens", "inputTokens", "reportedInputRequests"),
                        ("completionTokens", "outputTokens", "reportedOutputRequests"),
                        ("cachedInputTokens", "cachedInputTokens", "reportedCacheRequests"),
                    ):
                        value = usage.get(source)
                        if type(value) is int and value >= 0:
                            totals[total] += value
                            totals[reported] += 1
        return totals

    @staticmethod
    def _clear_restored_thread_leases(database_path: Path) -> None:
        """Remove owners from the terminated container before a safe resume."""

        try:
            connection = sqlite3.connect(database_path, timeout=5)
            try:
                connection.execute("DELETE FROM thread_leases")
                connection.commit()
            finally:
                connection.close()
        except sqlite3.Error as error:
            raise RuntimeError(
                "Unable to clear stale Thread leases in the restored checkpoint."
            ) from error

    @staticmethod
    def _checkpoint_copy_ignores(
        data_root: Path, directory: Path, names: list[str]
    ) -> set[str]:
        ignored = {
            name
            for name in names
            if name == "easy-code.db.lock"
            or name.startswith("easy-code.db.easy-code-advisory-lock")
        }
        if directory.resolve() == data_root.resolve() and "worktrees" in names:
            ignored.add("worktrees")
        return ignored

    def _prepare_restored_data(self, data_dir: Path) -> None:
        worktrees = data_dir / "worktrees"
        if worktrees.is_symlink():
            raise RuntimeError("The restored Worktree root cannot be a symlink.")
        if worktrees.exists():
            if not worktrees.is_dir():
                raise RuntimeError("The restored Worktree root is invalid.")
            shutil.rmtree(worktrees)
        self._clear_restored_thread_leases(data_dir / "easy-code.db")

    @staticmethod
    def _query_scalar(
        connection: sqlite3.Connection,
        query: str,
        parameters: tuple[Any, ...],
    ) -> int:
        row = connection.execute(query, parameters).fetchone()
        return int(row[0]) if row is not None else 0

    def _checkpoint_directory(self, binding: dict[str, Any]) -> Path:
        trial_key = binding.get("trialKey")
        if not isinstance(trial_key, str) or not re.fullmatch(r"[0-9a-f]{64}", trial_key):
            raise RuntimeError("The benchmark trial key is invalid.")
        # Keep the physical segment short enough for Windows Docker benchmark
        # roots while the binding and manifest retain the full 256-bit key.
        return self._checkpoint_root / trial_key[:32]

    @staticmethod
    def _require_binding(path: Path, expected: dict[str, Any]) -> None:
        actual = EasyCodeAgent._read_json_object(path)
        if actual != expected:
            raise RuntimeError(
                "Benchmark checkpoint binding mismatch; refusing cross-trial state."
            )

    @staticmethod
    def _read_json_object(path: Path) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Invalid benchmark checkpoint metadata: {path.name}") from error
        if not isinstance(value, dict):
            raise RuntimeError(f"Invalid benchmark checkpoint metadata: {path.name}")
        return value

    @staticmethod
    def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        staging = path.with_name(f".{path.name}.staging-{uuid.uuid4().hex}")
        data = (
            json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            + "\n"
        ).encode("utf-8")
        descriptor = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            offset = 0
            while offset < len(data):
                offset += os.write(descriptor, data[offset:])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            os.replace(staging, path)
        except Exception:
            staging.unlink(missing_ok=True)
            raise

    @staticmethod
    def _sha256_text(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _file_manifest(
        root: Path, excluded: set[str] | None = None
    ) -> dict[str, str]:
        excluded = excluded or set()
        manifest: dict[str, str] = {}
        for path_value in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
            if not path_value.is_file():
                continue
            relative = path_value.relative_to(root).as_posix()
            if relative in excluded:
                continue
            digest = hashlib.sha256()
            with path_value.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            manifest[relative] = digest.hexdigest()
        return manifest

    @staticmethod
    def _assert_regular_tree(
        root: Path, excluded_top_level: set[str] | None = None
    ) -> None:
        excluded_top_level = excluded_top_level or set()
        for path_value in root.rglob("*"):
            relative = path_value.relative_to(root)
            if relative.parts and relative.parts[0] in excluded_top_level:
                continue
            if path_value.is_symlink():
                raise RuntimeError("Symlinks are not allowed in benchmark checkpoints.")
            if not path_value.is_dir() and not path_value.is_file():
                raise RuntimeError("Special files are not allowed in benchmark checkpoints.")

    @staticmethod
    def _prune_generations(generations_dir: Path, current: str) -> None:
        generations = sorted(
            (
                entry
                for entry in generations_dir.iterdir()
                if entry.is_dir() and _GENERATION_PATTERN.fullmatch(entry.name)
            ),
            key=lambda entry: entry.stat().st_mtime_ns,
            reverse=True,
        )
        for stale in generations[_MAX_CHECKPOINT_GENERATIONS:]:
            if stale.name != current:
                shutil.rmtree(stale)

    async def _stage_api_key(self, environment: BaseEnvironment) -> None:
        """Upload an owner-only one-shot key without putting it in a command."""

        # This file is staged in the trusted controller only. Model commands
        # run in a separate offline worker without the controller's secret mount.
        owner = "root"
        ownership = ""
        if owner is not None:
            ownership = (
                f"chown {shlex.quote(str(owner))} "
                f"{shlex.quote(_REMOTE_SECRETS_DIR)} && "
            )
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {shlex.quote(_REMOTE_SECRETS_DIR)} && "
                + ownership
                + f"chmod 700 {shlex.quote(_REMOTE_SECRETS_DIR)}"
            ),
            timeout_sec=30,
        )
        await environment.upload_file(
            self._host_api_key_file,
            _REMOTE_API_KEY_FILE,
        )
        ownership = ""
        if owner is not None:
            ownership = f"chown {shlex.quote(str(owner))} {shlex.quote(_REMOTE_API_KEY_FILE)} && "
        await self.exec_as_root(
            environment,
            command=ownership + f"chmod 600 {shlex.quote(_REMOTE_API_KEY_FILE)}",
            timeout_sec=30,
        )

    async def _stage_model_registry(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="mkdir -p /root/.easy_code && chmod 700 /root/.easy_code",
            timeout_sec=30,
        )
        await environment.upload_file(self._model_registry_path, _REMOTE_MODEL_REGISTRY)
        await self.exec_as_root(
            environment,
            command=f"chmod 600 {shlex.quote(_REMOTE_MODEL_REGISTRY)}",
            timeout_sec=30,
        )
    def _record_output(self, filename: str, result: Any) -> None:
        """Persist command output while defensively removing the API key."""

        stdout = str(getattr(result, "stdout", "") or "")
        stderr = str(getattr(result, "stderr", "") or "")
        text = stdout
        if stderr:
            text += "\n\n[stderr]\n" + stderr
        text = self._redact(text)
        self._adapter_logs_dir.mkdir(parents=True, exist_ok=True)
        (self._adapter_logs_dir / filename).write_text(text, encoding="utf-8")

    def _truncate_output(self, text: str | None, max_len: int = 1000) -> str:
        """Redact before Harbor puts stdout/stderr into debug logs or errors."""

        return super()._truncate_output(self._redact(text), max_len)

    def _redact(self, text: str | None) -> str:
        value = text or ""
        return value.replace(self._api_key, "[REDACTED]") if self._api_key else value

    async def _restore_network_after_clean_exit(
        self, environment: BaseEnvironment, baseline: NetworkPolicy
    ) -> None:
        script = f"""
set -euo pipefail
for directory in {shlex.quote(_REMOTE_DATA_DIR + '/command-leases')} {shlex.quote(_REMOTE_DATA_DIR + '/command-quarantine')}; do
  if [ -d "$directory" ] && [ -n "$(find "$directory" -type f -print -quit)" ]; then
    echo 'Unfinished command or cleanup quarantine; verifier networking stays restricted' >&2
    exit 79
  fi
done
""".strip()
        checked = await environment.exec(command=self._bash(script), user="root", cwd="/", timeout_sec=30)
        code = getattr(checked, "return_code", getattr(checked, "exit_code", None))
        if code != 0:
            raise RuntimeError("Command cleanup was not confirmed; public verifier networking was not restored.")
        await environment.set_network_policy(baseline)

    def _require_success(self, label: str, result: Any) -> None:
        exit_code = getattr(result, "return_code", None)
        if exit_code is None:
            exit_code = getattr(result, "exit_code", None)
        if exit_code != 0:
            raise self._classify_exec_error(label, result)

    @staticmethod
    def _bash(script: str) -> str:
        return f"bash -lc {shlex.quote(script)}"
