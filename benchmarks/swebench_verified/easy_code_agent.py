"""Harbor adapter for evaluating a local EASY CODE package on SWE-bench.

The adapter deliberately receives the npm package and provider credential from
the host launcher. It never downloads EASY CODE from a registry and never
places the GLM Coding Plan key in a shell command or log message.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


_REMOTE_PACKAGE = "/tmp/easy-code-agent.tgz"
_REMOTE_DATA_DIR = "/logs/agent/easy-code-data"
_REMOTE_SECRETS_DIR = "/tmp/easy-code-secrets"
_REMOTE_API_KEY_FILE = f"{_REMOTE_SECRETS_DIR}/glm-coding-plan-api-key"
_TESTBED = "/testbed"
_MODEL_CATALOG_PATH = (
    Path(__file__).resolve().parents[2]
    / "resources"
    / "prompt-bundle"
    / "models"
    / "catalog.json"
)


def _load_benchmark_profile() -> tuple[str, str, str, str, str, str]:
    """Load the pinned benchmark profile from EASY CODE's model catalog."""

    try:
        catalog = json.loads(_MODEL_CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"Unable to load the EASY CODE model catalog at {_MODEL_CATALOG_PATH}."
        ) from error

    profile = catalog.get("profiles", {}).get("sweBenchVerified50")
    if not isinstance(profile, dict):
        raise RuntimeError(
            "The EASY CODE model catalog does not define profiles.sweBenchVerified50."
        )

    required_profile_fields = ("provider", "model", "mode", "thinkingEffort")
    if any(
        not isinstance(profile.get(field), str) or not profile[field].strip()
        for field in required_profile_fields
    ):
        raise RuntimeError("The SWE-bench model profile is incomplete.")

    provider_id = profile["provider"].strip()
    providers = catalog.get("providers")
    if not isinstance(providers, list):
        raise RuntimeError("The EASY CODE model catalog has no provider list.")
    provider = next(
        (
            entry
            for entry in providers
            if isinstance(entry, dict) and entry.get("id") == provider_id
        ),
        None,
    )
    if provider is None:
        raise RuntimeError(
            f"The SWE-bench provider {provider_id!r} is absent from the model catalog."
        )
    # SWE-bench deliberately uses the separately billed Coding Plan account.
    # Refuse catalog drift to the normal GLM platform rather than silently
    # consuming a different credential or endpoint.
    if provider_id != "glm-coding-plan":
        raise RuntimeError(
            "The SWE-bench profile must use the dedicated GLM Coding Plan provider."
        )

    models = provider.get("models")
    model_id = profile["model"].strip()
    if not isinstance(models, list) or not any(
        isinstance(model, dict) and model.get("id") == model_id for model in models
    ):
        raise RuntimeError(
            f"The SWE-bench model {model_id!r} is absent from provider {provider_id!r}."
        )

    endpoint = provider.get("defaultBaseUrl")
    environment = provider.get("environment")
    base_url_names = environment.get("baseUrl") if isinstance(environment, dict) else None
    api_key_names = environment.get("apiKey") if isinstance(environment, dict) else None
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise RuntimeError("The SWE-bench provider has no default endpoint.")
    endpoint_parts = urlsplit(endpoint.strip())
    if endpoint_parts.scheme != "https" or not endpoint_parts.hostname:
        raise RuntimeError("The SWE-bench provider must use a valid HTTPS endpoint.")
    if (
        not isinstance(base_url_names, list)
        or len(base_url_names) != 1
        or not isinstance(base_url_names[0], str)
        or not base_url_names[0]
    ):
        raise RuntimeError(
            "The SWE-bench provider must define one dedicated base-URL environment name."
        )
    if (
        not isinstance(api_key_names, list)
        or len(api_key_names) != 1
        or not isinstance(api_key_names[0], str)
        or not api_key_names[0]
    ):
        raise RuntimeError(
            "The SWE-bench provider must define one dedicated API-key environment name."
        )

    return (
        provider_id,
        model_id,
        profile["mode"].strip(),
        profile["thinkingEffort"].strip(),
        endpoint.strip(),
        base_url_names[0],
    )


(
    _BENCHMARK_PROVIDER,
    _BENCHMARK_MODEL,
    _BENCHMARK_MODE,
    _BENCHMARK_THINKING_EFFORT,
    _BENCHMARK_BASE_URL,
    _BENCHMARK_BASE_URL_ENV,
) = _load_benchmark_profile()


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

        api_key_file_value = os.environ.get(
            "EASY_CODE_GLM_CODING_PLAN_KEY_FILE", ""
        ).strip()
        if not api_key_file_value:
            raise RuntimeError(
                "EASY_CODE_GLM_CODING_PLAN_KEY_FILE must identify the launcher's private key file."
            )
        api_key_file = Path(api_key_file_value).resolve()
        if not api_key_file.is_file():
            raise RuntimeError(
                "The staged GLM Coding Plan credential file is unavailable."
            )
        api_key = api_key_file.read_text(encoding="utf-8").strip()
        if not api_key or len(api_key.encode("utf-8")) > 16_384:
            raise RuntimeError(
                "The staged GLM Coding Plan credential has an invalid size."
            )

        self._package_path = package_path
        self._host_api_key_file = api_key_file
        self._api_key = api_key
        self._adapter_logs_dir = Path(logs_dir)

    async def install(self, environment: BaseEnvironment) -> None:
        """Install Node and the exact locally packed EASY CODE build."""

        # Harbor 0.16.1 does not expose a system-dependency helper. Keep this
        # distro-aware bootstrap aligned with its built-in installed agents.
        await self.exec_as_root(
            environment,
            command=(
                "if [ -f /etc/alpine-release ]; then"
                "  apk add --no-cache bash ca-certificates curl git nodejs npm ripgrep;"
                " elif command -v apt-get >/dev/null 2>&1; then"
                "  apt-get update && DEBIAN_FRONTEND=noninteractive "
                "apt-get install -y ca-certificates curl git ripgrep;"
                " elif command -v yum >/dev/null 2>&1; then"
                "  yum install -y ca-certificates curl git ripgrep;"
                " else"
                '  echo "No supported package manager was found" >&2; exit 1;'
                " fi"
            ),
            timeout_sec=600,
        )
        await environment.upload_file(self._package_path, _REMOTE_PACKAGE)

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
easy-code --version
""".strip()

        result = await self.exec_as_agent(
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
        """Give one SWE-bench issue to EASY CODE and retain its stdout."""

        del context  # Harbor owns the lifecycle; EASY CODE owns its tool loop.
        easy_code_command = " ".join(
            (
                "easy-code",
                "--workspace",
                shlex.quote(_TESTBED),
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
                shlex.quote(instruction),
            )
        )
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
        try:
            await self._stage_api_key(environment)
            result = await environment.exec(
                command=self._bash(run_script),
                cwd=_TESTBED,
                env={
                    "EASY_CODE_GLM_CODING_PLAN_API_KEY_FILE": _REMOTE_API_KEY_FILE,
                    _BENCHMARK_BASE_URL_ENV: _BENCHMARK_BASE_URL,
                    "EASY_CODE_DATA_DIR": _REMOTE_DATA_DIR,
                    "EASY_CODE_OUTER_SANDBOX": "harbor",
                    "CI": "1",
                    "NO_COLOR": "1",
                },
                timeout_sec=3600,
            )
            self._record_output("easy-code.log", result)
            self._require_success("EASY CODE benchmark run", result)
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

    async def _stage_api_key(self, environment: BaseEnvironment) -> None:
        """Upload an owner-only one-shot key without putting it in a command."""

        owner = environment.default_user
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
            command=(
                ownership
                + f"chmod 600 {shlex.quote(_REMOTE_API_KEY_FILE)}"
            ),
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

    @staticmethod
    def _require_success(label: str, result: Any) -> None:
        exit_code = getattr(result, "return_code", None)
        if exit_code is None:
            exit_code = getattr(result, "exit_code", None)
        if exit_code not in (None, 0):
            raise RuntimeError(f"{label} failed with exit code {exit_code}; see agent logs.")

    @staticmethod
    def _bash(script: str) -> str:
        return f"bash -lc {shlex.quote(script)}"
