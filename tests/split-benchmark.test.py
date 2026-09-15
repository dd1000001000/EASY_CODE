"""Host boundary unit tests, without Docker, Harbor, network or model calls."""
import ast
import asyncio
import importlib.util
from pathlib import Path
import io
import json
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SOURCE = Path(__file__).parents[1] / "benchmarks/swebench_verified"
spec = importlib.util.spec_from_file_location("split_environment", SOURCE / "split_environment.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Split = module.SplitBenchmarkEnvironment


class WorkerBoundaryTests(unittest.TestCase):
    def test_split_containers_override_inherited_compose_main_labels(self):
        split = Split(None)
        try:
            for role in ("controller", "worker", "author", "reviewer"):
                labels = split.split_labels(role)
                self.assertEqual(labels, ("--label", f"com.docker.compose.project={split.name}",
                                          "--label", f"com.docker.compose.service={role}"))
                split.assert_split_labels({"Config": {"Labels": {
                    "com.docker.compose.project": split.name,
                    "com.docker.compose.service": role,
                }}}, role)
                with self.assertRaisesRegex(RuntimeError, "retained Harbor Compose labels"):
                    split.assert_split_labels({"Config": {"Labels": {
                        "com.docker.compose.project": "harbor-trial",
                        "com.docker.compose.service": "main",
                    }}}, role)
        finally:
            split._temp.cleanup()

    def test_resource_settings_are_bounded_and_verified(self):
        limits = {"shmMiB": 256, "pidsLimit": 512}
        self.assertEqual(Split.validate_resources(limits), limits)
        for change in ({"shmMiB": True}, {"shmMiB": 0}, {"pidsLimit": -1}, {"network": "host"}):
            with self.assertRaisesRegex(RuntimeError, "Invalid Benchmark"):
                Split.validate_resources({**limits, **change})
        info = {"HostConfig": {"NetworkMode": "none", "IpcMode": "private", "ShmSize": 256 * 1024 * 1024,
                "PidsLimit": 512, "SecurityOpt": ["no-new-privileges:true"]},
                "Mounts": [{"Type": "volume", "Name": "task", "Destination": "/testbed"}]}
        Split.validate_worker(info, "task", limits)
        for change in ({"ShmSize": 64}, {"PidsLimit": -1}, {"SecurityOpt": []}):
            with self.assertRaisesRegex(RuntimeError, "Unsafe Benchmark"):
                Split.validate_worker({**info, "HostConfig": {**info["HostConfig"], **change}}, "task", limits)

    def test_review_can_only_bind_runtime_private_copy(self):
        review = {"id": "review_" + "a" * 36, "actor": "reviewer",
                  "root": "/tmp/easy-code-review_" + "a" * 36 + "/reviewer"}
        self.assertEqual(Split.validate_review(review), review["id"] + "-reviewer")
        for change in ({"root": "/testbed"}, {"root": review["root"] + "/../author"},
                       {"actor": "main"}, {"root": "/"}, {"id": "review_bad"}, {"extra": True}):
            with self.assertRaisesRegex(RuntimeError, "Invalid review"):
                Split.validate_review({**review, **change})

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
    async def test_publishes_target_exit_before_worker_restoration_finishes(self):
        split = Split(None)
        split.worker_id = "worker"
        restart_started = asyncio.Event()
        finish_restart = asyncio.Event()

        async def docker(*args, **kwargs):
            if args[0] == "restart":
                restart_started.set()
                await finish_restart.wait()
            info = [{"State": {"Running": True}, "HostConfig": {"NetworkMode": "none", "IpcMode": "private"},
                     "Mounts": [{"Type": "volume", "Name": split.volume, "Destination": "/testbed"}]}]
            return SimpleNamespace(returncode=0, stdout=json.dumps(info), stderr="")

        split.docker = docker
        process = SimpleNamespace(poll=lambda: 0, wait=lambda *args: 0)
        try:
            directory = split.bridge / "commands" / "request-lifecycle"
            directory.mkdir()
            (directory / "request.json").write_text(json.dumps({"version": 1, "commandId": "command-test",
                "program": "node", "args": ["--version"], "cwd": "/testbed"}), encoding="utf-8")
            with patch.object(module.subprocess, "Popen", return_value=process):
                task = asyncio.create_task(split.execute_worker(directory))
                await asyncio.wait_for(restart_started.wait(), 1)
                execution = json.loads((directory / "execution.json").read_text(encoding="utf-8"))
                self.assertEqual(execution, {"version": 2, "exitCode": 0, "outcome": "exited"})
                self.assertFalse((directory / "result.json").exists())
                finish_restart.set()
                await task
            self.assertTrue((directory / "result.json").is_file())
        finally:
            finish_restart.set()
            split._temp.cleanup()

    async def test_output_limit_is_execution_failure_and_restored_worker_accepts_next_command(self):
        split = Split(None)
        split.worker_id = "worker"
        calls = []

        async def docker(*args, **kwargs):
            calls.append(args)
            info = [{"State": {"Running": True}, "HostConfig": {"NetworkMode": "none", "IpcMode": "private"},
                     "Mounts": [{"Type": "volume", "Name": split.volume, "Destination": "/testbed"}]}]
            return SimpleNamespace(returncode=0, stdout=json.dumps(info), stderr="")

        split.docker = docker

        class Process:
            def __init__(self, argv, stdout, stderr):
                # Sparse host test file, no 32 MiB allocation or actual process/Docker.
                stdout.seek(32 * 1024 * 1024 + 1)
            def poll(self): return 0
            def wait(self, *args): return 0

        try:
            for n in range(2):
                directory = split.bridge / "commands" / f"request-{n}"
                directory.mkdir()
                (directory / "request.json").write_text(json.dumps({"version": 1, "program": "python",
                    "args": ["test.py"], "cwd": "/testbed"}), encoding="utf-8")
                with patch.object(module.subprocess, "Popen", Process):
                    await split.execute_worker(directory)
                result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
                execution = json.loads((directory / "execution.json").read_text(encoding="utf-8"))
                self.assertEqual(result["outcome"], "output_limit")
                self.assertEqual(execution["outcome"], "output_limit")
                self.assertEqual(result["cleanup"], "confirmed")
                self.assertTrue(result["workerRestored"])
                self.assertNotIn("cleanupError", result)
                self.assertFalse(split.stopped)
            self.assertEqual(sum(c[0] == "restart" for c in calls), 2)
        finally:
            split._temp.cleanup()

    async def test_failed_worker_restart_is_separate_cleanup_failure(self):
        split = Split(None)
        split.worker_id = "worker"

        async def docker(*args, **kwargs):
            if args[0] == "restart": raise RuntimeError("restart unavailable")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        split.docker = docker
        process = SimpleNamespace(poll=lambda: 0, wait=lambda *args: 1)
        try:
            directory = split.bridge / "commands" / "request-failure"
            directory.mkdir()
            (directory / "request.json").write_text(json.dumps({"version": 1, "program": "python",
                "args": ["test.py"], "cwd": "/testbed"}), encoding="utf-8")
            with patch.object(module.subprocess, "Popen", return_value=process):
                await split.execute_worker(directory)
            result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["outcome"], "exited")
            self.assertEqual(result["exitCode"], 1)
            self.assertEqual(result["cleanup"], "failed")
            self.assertFalse(result["workerRestored"])
            self.assertTrue(split.stopped)
        finally:
            split._temp.cleanup()

    async def test_review_uses_private_offline_volume_and_reuses_only_its_bound_worker(self):
        split = Split(None)
        split.controller = "controller"
        split.worker_id = "main-worker"
        review = {"id": "review_" + "a" * 36, "actor": "author",
                  "root": "/tmp/easy-code-review_" + "a" * 36 + "/author"}
        calls, copies = [], []

        async def docker(*args, **kwargs):
            calls.append(args)
            result = ""
            if args[0] == "exec":
                result = review["root"] + "\n"
            elif args[0] == "inspect":
                item = next(iter(split.review_workers.values()))
                result = json.dumps([{"Id": "a" * 64, "HostConfig": {"NetworkMode": "none", "IpcMode": "private",
                    "ShmSize": split.resources["shmMiB"] * 1024 * 1024, "PidsLimit": split.resources["pidsLimit"], "SecurityOpt": ["no-new-privileges:true"]},
                    "Config": {"Labels": {"com.docker.compose.project": split.name,
                                          "com.docker.compose.service": review["actor"]}},
                    "Mounts": [{"Type": "volume", "Name": split.volume if args[1] == "main-worker" else item["volume"], "Destination": "/testbed"}]}])
            return SimpleNamespace(returncode=0, stdout=result, stderr="")

        split.docker = docker
        split.copy_archive_out = lambda container, target, root="/testbed": copies.append(("out", container, root))
        split.copy_archive_in = lambda container, source, root="/testbed": copies.append(("in", container, root))
        split.dependency_archive = lambda source, target: None
        split.dependency_digest = lambda source: "environment-digest"
        try:
            worker = await split.review_worker(review)
            count = len(calls)
            self.assertIs(await split.review_worker(review), worker)
            self.assertEqual(len(calls), count)
            create = next(call for call in calls if call[0] == "create")
            self.assertIn(f"com.docker.compose.project={split.name}", create)
            self.assertIn("com.docker.compose.service=author", create)
            self.assertEqual(create[create.index("--network") + 1], "none")
            self.assertEqual(create[create.index("--ipc") + 1], "private")
            self.assertEqual(create[create.index("--mount") + 1], f'type=volume,source={worker["volume"]},target=/testbed')
            self.assertNotEqual(worker["volume"], split.volume)
            self.assertFalse(any("bridge" in arg or "volumes-from" in arg for arg in create))
            self.assertIn("--read-only", create)
            self.assertTrue(any(call[0] == "commit" and call[1] == "main-worker" for call in calls))
            self.assertFalse(any(call[0] == "commit" and call[1] == "controller" for call in calls))
            self.assertEqual(copies[0], ("out", "controller", review["root"]))
            self.assertEqual(copies[1][2], "/testbed")
        finally:
            await split.close()
        self.assertIn(("rm", "--force", worker["name"]), calls)
        self.assertIn(("volume", "rm", worker["volume"]), calls)

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

    async def test_checkpoint_copy_targets_bound_harbor_main_id_not_compose_service(self):
        split = Split(None)
        split.main = "a" * 64
        calls = []

        async def docker(*args, **kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        split.docker = docker
        try:
            with tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary)
                await split.copy_checkpoint_from_main(target)
                self.assertEqual(calls, [("cp", f"{split.main}:/tmp/easy-code-checkpoint/.", target)])
            split.main = "main"
            with self.assertRaisesRegex(RuntimeError, "binding is unavailable"):
                await split.copy_checkpoint_from_main(Path(temporary))
        finally:
            split._temp.cleanup()


if __name__ == "__main__":
    unittest.main()
