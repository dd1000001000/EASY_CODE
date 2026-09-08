"""Exercise the adapter's actual network-restoration method without Harbor/Docker."""
import ast
import asyncio
import json
import re
from pathlib import Path
import shlex
from types import SimpleNamespace
from typing import Any
import unittest

SOURCE = Path(__file__).parents[1] / "benchmarks/swebench_verified/easy_code_agent.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
agent = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EasyCodeAgent")
method = next(node for node in agent.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "_restore_network_after_clean_exit")
namespace = {"BaseEnvironment": object, "NetworkPolicy": object, "shlex": shlex, "_REMOTE_DATA_DIR": "/logs/agent/easy-code-data"}
exec(compile(ast.Module(body=[method], type_ignores=[]), str(SOURCE), "exec"), namespace)
restore = namespace[method.name]


class DockerFixture:
    async def assert_private_ipc(self):
        pass

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
    async def test_rejects_shared_ipc_before_installation(self):
        class UnsafeDocker(DockerFixture):
            async def assert_private_ipc(self):
                raise RuntimeError("private Docker IPC required")
        with self.assertRaisesRegex(RuntimeError, "private Docker IPC"):
            await install(SimpleNamespace(), UnsafeDocker())

    async def test_rejects_non_managed_environment_before_any_execution(self):
        with self.assertRaisesRegex(RuntimeError, "trusted Harbor Docker"):
            await install(SimpleNamespace(), object())

    async def test_install_prepares_controller_without_nested_sandbox(self):
        commands = []

        async def execute(*args, **kwargs):
            commands.append(kwargs["command"])
            return SimpleNamespace(return_code=0)

        owner = SimpleNamespace(exec_as_root=execute, _package_path="package", _model_directory="model",
                                _bash=lambda script: script, _record_output=lambda *args: None,
                                _require_success=lambda *args: None)
        await install(owner, DockerFixture())
        script = commands[-1]
        self.assertNotIn("harbor-sandbox.c", script)
        self.assertNotIn("easy-code sandbox doctor", script)
        self.assertIn("dist/sandbox/benchmark-backend.js", script)
        self.assertIn("rebuild and repack", script)
        self.assertIn("controller", script)
        self.assertNotIn("Mandatory inner sandbox", script)
        self.assertNotIn("--privileged", script)


ipc_node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_validate_private_ipc")
ipc_namespace = {"Any": Any}
exec(compile(ast.Module(body=[ipc_node], type_ignores=[]), str(SOURCE), "exec"), ipc_namespace)
validate_ipc = ipc_namespace["_validate_private_ipc"]


class PrivateIpcTests(unittest.TestCase):
    def test_accepts_bounded_private_pool_and_unrelated_workspace_mounts(self):
        validate_ipc({"ipc": "private", "shmBytes": 67108864, "privileged": False,
                      "mounts": [{"Destination": "/testbed"}]})

    def test_rejects_host_shared_unbounded_and_external_mounts(self):
        baseline = {"ipc": "private", "shmBytes": 67108864, "privileged": False, "mounts": []}
        cases = [{"ipc": value} for value in ("host", "shareable", "container:abc", "", None)]
        cases += [{"shmBytes": value} for value in (0, -1, True, 2**30, "67108864")]
        cases += [{"privileged": True}, {"mounts": None}]
        cases += [{"mounts": [{"Destination": value}]} for value in ("/", "/dev", "/dev/shm", "/dev/shm/", "/dev/shm/nested")]
        for override in cases:
            with self.subTest(override=override), self.assertRaises(RuntimeError):
                validate_ipc({**baseline, **override})


environment_node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EasyCodeBenchmarkDockerEnvironment")
assert_ipc_node = next(node for node in environment_node.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "assert_private_ipc")
assert_ipc_namespace = {"asyncio": asyncio, "json": json, "re": re, "_validate_private_ipc": validate_ipc}
exec(compile(ast.Module(body=[assert_ipc_node], type_ignores=[]), str(SOURCE), "exec"), assert_ipc_namespace)


class IpcInspectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_inspects_exact_main_container_without_exposing_environment(self):
        calls = []

        async def compose(args, **kwargs):
            self.assertEqual(args, ["ps", "-q", "main"])
            self.assertEqual(kwargs["timeout_sec"], 30)
            return SimpleNamespace(stdout="a" * 64 + "\n")

        def inspect(args, **kwargs):
            calls.append(args)
            self.assertEqual(args[:3], ["docker", "inspect", "--format"])
            self.assertEqual(args[-1], "a" * 64)
            self.assertNotIn(".Config.Env", args[3])
            self.assertEqual(kwargs["timeout"], 30)
            self.assertTrue(kwargs["check"])
            return SimpleNamespace(stdout=json.dumps({"ipc": "private", "shmBytes": 67108864,
                "privileged": False, "mounts": []}))

        assert_ipc_namespace["subprocess"] = SimpleNamespace(run=inspect)
        await assert_ipc_namespace["assert_private_ipc"](SimpleNamespace(_run_docker_compose_command=compose))
        self.assertEqual(len(calls), 1)

    async def test_rejects_ambiguous_container_ids_before_docker_inspect(self):
        async def compose(*args, **kwargs):
            return SimpleNamespace(stdout="a" * 64 + "\n" + "b" * 64)
        with self.assertRaisesRegex(RuntimeError, "identify"):
            await assert_ipc_namespace["assert_private_ipc"](SimpleNamespace(_run_docker_compose_command=compose))


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
