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


class NetworkRestorationTests(unittest.IsolatedAsyncioTestCase):
    async def check(self, result, error=None):
        calls = []

        async def execute(**kwargs):
            self.assertIn("command-leases", kwargs["command"])
            self.assertIn("command-quarantine", kwargs["command"])
            self.assertEqual(kwargs["timeout_sec"], 30)
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
