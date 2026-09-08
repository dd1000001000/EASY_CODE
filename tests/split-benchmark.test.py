"""Host boundary unit tests, without Docker, Harbor, network or model calls."""
import ast
import importlib.util
from pathlib import Path
import io
import tarfile
import tempfile
import unittest
from types import SimpleNamespace

SOURCE = Path(__file__).parents[1] / "benchmarks/swebench_verified"
spec = importlib.util.spec_from_file_location("split_environment", SOURCE / "split_environment.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Split = module.SplitBenchmarkEnvironment


class WorkerBoundaryTests(unittest.TestCase):
    def test_accepts_only_offline_private_worker_with_one_task_volume(self):
        baseline = {"HostConfig": {"NetworkMode": "none", "IpcMode": "private"},
                    "Mounts": [{"Type": "volume", "Name": "task", "Destination": "/testbed"}]}
        Split.validate_worker(baseline, "task")
        for changes in ({"NetworkMode": "bridge"}, {"Privileged": True}, {"PidMode": "host"},
                        {"IpcMode": "host"}, {"CapAdd": ["SYS_ADMIN"]}, {"Devices": ["device"]}):
            with self.assertRaisesRegex(RuntimeError, "Unsafe Benchmark"):
                Split.validate_worker({**baseline, "HostConfig": {**baseline["HostConfig"], **changes}}, "task")
        for mounts in ([], baseline["Mounts"] + [{"Type": "bind", "Destination": "/source"}],
                       [{"Type": "bind", "Name": "task", "Destination": "/testbed"}]):
            with self.assertRaisesRegex(RuntimeError, "Unsafe Benchmark"):
                Split.validate_worker({**baseline, "Mounts": mounts}, "task")

    def archive(self, filename, entries):
        with tarfile.open(filename, "w") as archive:
            for name, content, kind in entries:
                member = tarfile.TarInfo(name)
                if kind == "link":
                    member.type = tarfile.SYMTYPE
                    member.linkname = content
                    archive.addfile(member)
                else:
                    data = content.encode()
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))

    def test_exports_project_changes_but_not_worker_git_control_files_or_new_links(self):
        with tempfile.TemporaryDirectory() as root:
            initial, candidate, output = [Path(root) / name for name in ("initial.tar", "candidate.tar", "output.tar")]
            self.archive(initial, [("original-link", "module.py", "link")])
            self.archive(candidate, [("module.py", "patched", "file"), (".git/config", "unsafe", "file"),
                (".easycode/config.toml", "unsafe", "file"), ("escape", "/tests", "link"),
                ("original-link", "module.py", "link")])
            Split.filter_archive(initial, candidate, output)
            with tarfile.open(output) as result:
                self.assertEqual(result.getnames(), ["module.py", "original-link"])
                self.assertEqual(result.extractfile("module.py").read(), b"patched")

    def test_rejects_archive_traversal(self):
        with tempfile.TemporaryDirectory() as root:
            initial, candidate, output = [Path(root) / name for name in ("initial.tar", "candidate.tar", "output.tar")]
            self.archive(initial, [])
            for name in ("../outside", "/absolute", "a\\outside"):
                self.archive(candidate, [(name, "bad", "file")])
                with self.assertRaisesRegex(RuntimeError, "Unsafe workspace"):
                    Split.filter_archive(initial, candidate, output)

    def test_creates_boundary_before_staging_credentials_and_exports_before_network_restore(self):
        source = (SOURCE / "easy_code_agent.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        agent = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EasyCodeAgent")
        run = next(node for node in agent.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "run")
        text = ast.get_source_segment(source, run)
        self.assertLess(text.index("SplitBenchmarkEnvironment.create"), text.index("self._stage_api_key"))
        self.assertLess(text.index("split_environment.export_workspace"), text.index("self._restore_network_after_clean_exit"))
        self.assertIn("await split_environment.close()", text)


class CleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_partial_setup_resources_are_already_clean(self):
        split = Split(None)
        calls = []

        async def docker(*args, **kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=1, stderr="No such container: already removed")

        split.docker = docker
        await split.close()
        self.assertEqual(len(calls), 5)
        self.assertFalse(split.root.exists())

    async def test_cleanup_failure_is_reported_after_attempting_all_owned_resources(self):
        split = Split(None)
        calls = []

        async def docker(*args, **kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=1, stderr="Docker daemon unavailable")

        split.docker = docker
        try:
            with self.assertRaisesRegex(RuntimeError, "cleanup was not confirmed"):
                await split.close()
            self.assertEqual(len(calls), 5)
            self.assertTrue(split.root.exists())
        finally:
            split._temp.cleanup()


if __name__ == "__main__":
    unittest.main()
