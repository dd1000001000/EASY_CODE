"""Exercise the adapter's actual network-restoration method without Harbor/Docker."""
import ast
import asyncio
from pathlib import Path
import shlex
from types import SimpleNamespace
import unittest

SOURCE = Path(__file__).parents[1] / "benchmarks/swebench_verified/easy_code_agent.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
agent = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EasyCodeAgent")
method = next(node for node in agent.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "_restore_network_after_clean_exit")
namespace = {"BaseEnvironment": object, "NetworkPolicy": object, "shlex": shlex, "_REMOTE_DATA_DIR": "/logs/agent/easy-code-data"}
exec(compile(ast.Module(body=[method], type_ignores=[]), str(SOURCE), "exec"), namespace)
restore = namespace[method.name]


class DockerFixture:
    async def upload_file(self, *args):
        pass

    async def upload_dir(self, *args):
        pass


install_node = next(node for node in agent.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "install")
install_namespace = {"BaseEnvironment": object, "EasyCodeBenchmarkDockerEnvironment": DockerFixture, "shlex": shlex,
                     "_REMOTE_PACKAGE": "/tmp/package.tgz", "_REMOTE_MODEL_DIR": "/tmp/model", "_REMOTE_CACHE_DIR": "/tmp/cache"}
exec(compile(ast.Module(body=[install_node], type_ignores=[]), str(SOURCE), "exec"), install_namespace)
install = install_namespace["install"]


class InstallationTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_non_managed_environment_before_any_execution(self):
        with self.assertRaisesRegex(RuntimeError, "trusted Harbor Docker"):
            await install(SimpleNamespace(), object())

    async def test_install_selects_same_harbor_preflight_as_runtime(self):
        commands = []

        async def execute(*args, **kwargs):
            commands.append(kwargs["command"])
            return SimpleNamespace(return_code=0)

        owner = SimpleNamespace(exec_as_root=execute, _package_path="package", _model_directory="model",
                                _bash=lambda script: script, _record_output=lambda *args: None,
                                _require_success=lambda *args: None)
        await install(owner, DockerFixture())
        script = commands[-1]
        self.assertIn("harbor-sandbox.c", script)
        self.assertIn("-Wall -Wextra -Werror", script)
        self.assertLess(script.index("export EASY_CODE_OUTER_SANDBOX=harbor"), script.index("easy-code sandbox doctor"))
        self.assertNotIn("Mandatory inner sandbox", script)
        self.assertNotIn("--privileged", script)


class NetworkRestorationTests(unittest.IsolatedAsyncioTestCase):
    async def check(self, result, error=None):
        calls = []

        async def execute(**kwargs):
            self.assertIn("command-leases", kwargs["command"])
            self.assertIn("command-quarantine", kwargs["command"])
            self.assertEqual(kwargs["timeout_sec"], 30)
            self.assertEqual(kwargs["user"], "root")
            if error:
                raise error
            return result

        async def set_policy(value):
            calls.append(value)

        environment = SimpleNamespace(exec=execute, set_network_policy=set_policy)
        owner = SimpleNamespace(_bash=lambda script: script)
        return owner, environment, calls

    async def test_clean_probe_restores_exact_baseline(self):
        owner, environment, calls = await self.check(SimpleNamespace(return_code=0))
        baseline = object()
        await restore(owner, environment, baseline)
        self.assertEqual(calls, [baseline])

    async def test_quarantine_keeps_network_restricted(self):
        owner, environment, calls = await self.check(SimpleNamespace(return_code=79))
        with self.assertRaises(RuntimeError):
            await restore(owner, environment, object())
        self.assertEqual(calls, [])

    async def test_missing_exit_code_is_not_success(self):
        owner, environment, calls = await self.check(SimpleNamespace())
        with self.assertRaises(RuntimeError):
            await restore(owner, environment, object())
        self.assertEqual(calls, [])

    async def test_probe_timeout_never_restores_network(self):
        owner, environment, calls = await self.check(None, asyncio.TimeoutError())
        with self.assertRaises(asyncio.TimeoutError):
            await restore(owner, environment, object())
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
