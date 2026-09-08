"""Offline integration smoke: no model calls, no user jobs are modified."""
import asyncio
import importlib.util
from pathlib import Path
import uuid

spec = importlib.util.spec_from_file_location("split_environment", Path(__file__).resolve().parents[1] / "benchmarks/swebench_verified/split_environment.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Split = module.SplitBenchmarkEnvironment

async def main():
    name = "easy-code-split-smoke-" + uuid.uuid4().hex[:12]
    source = Path(__file__).resolve().parents[1].as_posix()
    await Split.docker("run", "-d", "--name", name, "--network", "none", "--mount", f"type=bind,source={source},target=/source,readonly",
        "--entrypoint", "/bin/sh", "easy-code-harbor-django-smoke:shm", "-c", "while :; do sleep 3600; done")
    class Original:
        async def _run_docker_compose_command(self, args, timeout_sec):
            return await Split.docker("inspect", "--format", "{{.Id}}", name)
    split = None
    try:
        split = await Split.create(Original())
        result = await split.exec("node /source/scripts/smoke-split-controller.mjs", timeout_sec=180)
        print(result.stdout)
        print(result.stderr)
        if result.return_code:
            raise RuntimeError("Controller smoke failed")
        await split.export_workspace()
        marker = await Split.docker("exec", name, "cat", "/testbed/split-smoke-marker.txt")
        assert marker.stdout.strip() == "worker patch"
        absent = await Split.docker("exec", name, "test", "!", "-e", "/etc/easy-code-worker-only", check=False)
        assert absent.returncode == 0, "Worker root mutation escaped into verifier"
        print("Split controller/worker/clean verifier smoke passed; no model requests.")
    finally:
        if split:
            await split.close()
        await Split.docker("rm", "--force", name, check=False)

asyncio.run(main())
