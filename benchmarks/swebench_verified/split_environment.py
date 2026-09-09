"""Host-owned Docker control plane. Never mount Docker or this bridge in a worker.

The controller and offline worker share only /testbed. Harbor's original main
container remains the clean verifier environment. No model credentials are put
in images, worker env, shared volumes or command request packets.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tarfile
import time
from types import SimpleNamespace
import uuid
import hashlib
import posixpath


class SplitBenchmarkEnvironment:
    def __init__(self, original):
        self.original = original
        self.name = "easy-code-split-" + uuid.uuid4().hex
        self.volume = self.name + "-workspace"
        self.git_volume = self.name + "-controller-git"
        self.image = self.name + ":controller"
        self.controller = self.name + "-controller"
        self.worker = self.name + "-worker"
        self._temp = tempfile.TemporaryDirectory(prefix="easy-code-command-control-")
        self.root = Path(self._temp.name)
        self.bridge = self.root / "bridge"
        self.bridge.mkdir()
        (self.bridge / "commands").mkdir()
        self.stopping = False
        self.broker = None
        self.stopped = False
        self.review_workers = {}
        self.review_images = {}

    @staticmethod
    async def docker(*args, timeout=120, check=True):
        result = await asyncio.to_thread(subprocess.run, ["docker", *map(str, args)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f"Docker control operation {args[0]} failed: {result.stderr[-2000:]}")
        return result

    @classmethod
    async def create(cls, original):
        obj = cls(original)
        try:
            found = await original._run_docker_compose_command(["ps", "-q", "main"], timeout_sec=30)
            main = str(found.stdout or "").strip()
            if not re.fullmatch(r"[a-f0-9]{12,64}", main):
                raise RuntimeError("Cannot bind split environment to one Harbor main container")
            obj.main = main
            main_info = json.loads((await obj.docker("inspect", main)).stdout)[0]
            for entry in main_info.get("Config", {}).get("Env", []):
                key, _, value = entry.partition("=")
                if value and re.search(r"(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)", key, re.I):
                    raise RuntimeError("Refusing to snapshot a credential-bearing container environment")
            # This happens BEFORE the adapter stages the provider key.
            await obj.docker("commit", main, obj.image, timeout=300)
            await obj.docker("volume", "create", obj.volume)
            await obj.docker("volume", "create", obj.git_volume)
            mount = f"type=volume,source={obj.volume},target=/testbed"
            await obj.docker("create", "--name", obj.controller, "--network", f"container:{main}",
                "--volumes-from", main, "--mount", mount,
                "--mount", f"type=volume,source={obj.git_volume},target=/testbed/.git",
                "--mount", f"type=bind,source={obj.bridge},target=/opt/easy-code-command-bridge",
                "--entrypoint", "/bin/sh", obj.image, "-c", "while :; do sleep 3600; done")
            await obj.docker("create", "--name", obj.worker, "--network", "none", "--ipc", "private",
                "--shm-size", "64m", "--security-opt", "no-new-privileges:true", "--mount", mount,
                "--entrypoint", "/bin/sh", obj.image, "-c", "while :; do sleep 3600; done")
            await obj.docker("start", obj.controller, obj.worker)
            # Harbor datasets may mount /testbed, which docker commit excludes.
            obj.initial = obj.root / "initial.tar"
            await asyncio.to_thread(obj.copy_archive_out, main, obj.initial)
            await asyncio.to_thread(obj.copy_archive_in, obj.controller, obj.initial)
            # The controller's Git database/hooks/config never come from the
            # worker. Its own copy is hidden behind a private nested volume.
            await asyncio.to_thread(obj.copy_archive_in, obj.worker, obj.initial)
            info = json.loads((await obj.docker("inspect", obj.worker)).stdout)[0]
            obj.validate_worker(info, obj.volume)
            obj.worker_id = info["Id"]
            (obj.bridge / "binding.json").write_text(json.dumps({"version": 1,
                "workerId": obj.worker_id, "network": "none"}), encoding="utf-8")
            obj.broker = asyncio.create_task(obj.serve())
            return obj
        except BaseException:
            await obj.close()
            raise

    @staticmethod
    def validate_worker(info, volume):
        config = info["HostConfig"]
        mounts = info.get("Mounts", [])
        if (config.get("NetworkMode") != "none" or config.get("Privileged") or
            config.get("PidMode") or config.get("IpcMode") != "private" or config.get("Devices") or
            config.get("CapAdd") or len(mounts) != 1 or
            mounts[0].get("Type") != "volume" or mounts[0].get("Name") != volume or
            mounts[0].get("Destination") != "/testbed"):
            raise RuntimeError("Unsafe Benchmark worker: expected offline private container with only task volume")

    @property
    def network_policy(self):
        return self.original.network_policy

    async def set_network_policy(self, policy):
        return await self.original.set_network_policy(policy)

    async def exec(self, command, cwd="/", user="root", env=None, timeout_sec=120, **_):
        argv = ["exec", "--user", user or "root", "--workdir", cwd or "/"]
        for key, value in (env or {}).items():
            argv += ["--env", f"{key}={value}"]
        result = await self.docker(*argv, self.controller, "/bin/bash", "-c", command,
            timeout=timeout_sec, check=False)
        return SimpleNamespace(stdout=result.stdout, stderr=result.stderr, return_code=result.returncode)

    async def upload_file(self, source_path, target_path):
        await self.docker("cp", source_path, f"{self.controller}:{target_path}")

    async def upload_dir(self, source_path, target_path):
        await self.docker("cp", str(source_path) + "/.", f"{self.controller}:{target_path}")

    async def serve(self):
        handled = set()
        while not self.stopping:
            for directory in (self.bridge / "commands").iterdir():
                if directory in handled or not (directory / "request.json").is_file():
                    continue
                handled.add(directory)
                await self.execute_worker(directory)
            await asyncio.sleep(0.05)

    @staticmethod
    def validate_review(value):
        if (not isinstance(value, dict) or set(value) != {"id", "actor", "root"} or
                not all(isinstance(value.get(key), str) for key in ("id", "actor", "root")) or
                not re.fullmatch(r"review_[a-f0-9-]{36}", value.get("id", "")) or
                value.get("actor") not in ("author", "reviewer") or
                value.get("root") != f'/tmp/easy-code-{value["id"]}/{value["actor"]}'):
            raise RuntimeError("Invalid review copy binding")
        return value["id"] + "-" + value["actor"]

    async def review_worker(self, review):
        key = self.validate_review(review)
        existing = self.review_workers.get(key)
        if existing:
            if existing["root"] != review["root"] or existing.get("failed"):
                raise RuntimeError("Review worker unavailable or binding changed")
            return existing
        if len(self.review_workers) >= 20:
            raise RuntimeError("Review container budget exhausted")
        name = self.name + "-" + key
        item = {"name": name, "volume": name + "-workspace", "root": review["root"],
                "initial": self.root / (key + "-initial.tar")}
        self.review_workers[key] = item  # Cleanup also covers partial setup.
        resolved = await self.docker("exec", self.controller, "realpath", "-e", review["root"])
        if resolved.stdout.strip() != review["root"]:
            raise RuntimeError("Redirected review copy")
        await asyncio.to_thread(self.copy_archive_out, self.controller, item["initial"], review["root"])
        # Snapshot the credential-free execution worker, NEVER the controller.
        # Both participants use one environment revision even across later calls.
        environment = self.review_images.get(review["id"])
        if environment is None:
            info = json.loads((await self.docker("inspect", self.worker_id)).stdout)[0]
            self.validate_worker(info, self.volume)
            for entry in info.get("Config", {}).get("Env", []):
                key, _, value = entry.partition("=")
                if value and re.search(r"(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)", key, re.I):
                    raise RuntimeError("Refusing a credential-bearing review environment")
            environment = {"image": self.name + ":" + review["id"],
                           "dependencies": self.root / (review["id"] + "-dependencies.tar")}
            self.review_images[review["id"]] = environment
            await self.docker("commit", self.worker_id, environment["image"], timeout=300)
            volume_archive = self.root / (review["id"] + "-worker-volume.tar")
            await asyncio.to_thread(self.copy_archive_out, self.worker_id, volume_archive)
            await asyncio.to_thread(self.dependency_archive, volume_archive, environment["dependencies"])
            environment["digest"] = self.dependency_digest(environment["dependencies"])
        item["dependency_digest"] = environment["digest"]
        await self.docker("volume", "create", item["volume"])
        await self.docker("create", "--name", name, "--network", "none", "--ipc", "private", "--shm-size", "64m",
            "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev", "--tmpfs", "/run:rw,nosuid,nodev",
            "--security-opt", "no-new-privileges:true", "--mount", f'type=volume,source={item["volume"]},target=/testbed',
            "--entrypoint", "/bin/sh", environment["image"], "-c", "while :; do sleep 3600; done")
        await self.docker("start", name)
        await asyncio.to_thread(self.copy_archive_in, name, environment["dependencies"])
        await asyncio.to_thread(self.copy_archive_in, name, item["initial"])
        info = json.loads((await self.docker("inspect", name)).stdout)[0]
        self.validate_worker(info, item["volume"])
        item["id"] = info["Id"]
        return item

    async def sync_review(self, item):
        # Only regular files may return to the exact Runtime-created disposable
        # copy. The worker never sees controller data, its bridge or /testbed.
        candidate = self.root / (item["name"] + "-result.tar")
        filtered = self.root / (item["name"] + "-filtered.tar")
        await asyncio.to_thread(self.copy_archive_out, item["id"], candidate)
        item["environment_unchanged"] = self.dependency_digest(candidate) == item["dependency_digest"]
        await asyncio.to_thread(self.filter_archive, item["initial"], candidate, filtered, True)
        script = ('import os,re,shutil,sys\np=sys.argv[1]\n'
            'if not re.fullmatch(r"/tmp/easy-code-review_[a-f0-9-]{36}/(?:author|reviewer)",p): raise RuntimeError("Invalid review root")\n'
            'if os.path.realpath(p)!=p or os.path.islink(p): raise RuntimeError("Redirected review root")\n'
            'shutil.rmtree(p)\nos.mkdir(p,0o700)')
        await self.docker("exec", self.controller, "python", "-c", script, item["root"])
        await asyncio.to_thread(self.copy_archive_in, self.controller, filtered, item["root"])

    async def execute_worker(self, directory):
        result = {"version": 2, "exitCode": 125, "outcome": "unknown",
                  "cleanup": "unknown", "workerRestored": False}
        proc = None
        review = None
        is_review = False
        worker_id = self.worker_id
        try:
            data = json.loads((directory / "request.json").read_text(encoding="utf-8"))
            if (data.get("version") != 1 or not isinstance(data.get("args"), list) or
                not isinstance(data.get("program"), str) or not data["program"] or any(c in data["program"] for c in "\0\r\n") or
                not isinstance(data.get("cwd"), str) or not data["cwd"].startswith("/") or
                len(data["args"]) > 256 or any(not isinstance(a, str) or "\0" in a for a in data["args"])):
                raise RuntimeError("Malformed controller command")
            if self.stopped or self.stopping:
                raise RuntimeError("Benchmark worker has stopped")
            if "review" in data:
                is_review = True
                review = await self.review_worker(data["review"])
                worker_id = review["id"]
                # Both file tools and commands name the private controller copy;
                # the isolated worker only has its own /testbed volume.
                root = review["root"]
                data["program"] = data["program"].replace(root, "/testbed")
                data["cwd"] = data["cwd"].replace(root, "/testbed")
                data["args"] = [arg.replace(root, "/testbed") for arg in data["args"]]
                data["environment"] = {k: v.replace(root, "/testbed") for k, v in data.get("environment", {}).items()}
            # Clear image-level Git helper/credential env too, not just the
            # controller's environment. Docker otherwise inherits image ENV.
            argv = ["docker", "exec", "--workdir", data["cwd"], worker_id, "/usr/bin/env", "-i"]
            for key, value in data.get("environment", {}).items():
                if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or not isinstance(value, str):
                    raise RuntimeError("Invalid command environment")
                argv += [f"{key}={value}"]
            argv += [data["program"], *data["args"]]
            with (directory / "stdout").open("wb") as stdout, (directory / "stderr").open("wb") as stderr:
                proc = subprocess.Popen(argv, stdout=stdout, stderr=stderr)
                deadline = time.monotonic() + min(max(data.get("timeoutMs", 120000), 1), 1200000) / 1000
                while proc.poll() is None:
                    oversized = stdout.tell() + stderr.tell() > 32 * 1024 * 1024
                    if self.stopping or (directory / "cancel").exists() or time.monotonic() > deadline or oversized:
                        await self.docker("stop", "--time", "0", worker_id)
                        result["outcome"] = "output_limit" if oversized else (
                            "canceled" if self.stopping or (directory / "cancel").exists() else "timed_out")
                        if oversized:
                            result["executionError"] = "Command output exceeded the 32 MiB bridge limit; do not automatically replay it"
                        break
                    await asyncio.sleep(0.05)
                result["exitCode"] = await asyncio.to_thread(proc.wait, 15)
                if stdout.tell() + stderr.tell() > 32 * 1024 * 1024:
                    result["outcome"] = "output_limit"
                    result["executionError"] = "Command output exceeded the 32 MiB bridge limit; do not automatically replay it"
                elif result["outcome"] == "unknown":
                    result["outcome"] = "exited"
            # Docker owns the cgroup: restarting kills even detached descendants.
            # The writable layer and /testbed persist; process state does not.
            if not self.stopping:
                await self.docker("restart", "--time", "0", worker_id, timeout=30)
                restored = json.loads((await self.docker("inspect", worker_id)).stdout)[0]
                self.validate_worker(restored, review["volume"] if review else self.volume)
                if (restored.get("State", {}).get("Running") is not True or
                        restored.get("State", {}).get("Paused") or restored.get("State", {}).get("Restarting")):
                    raise RuntimeError("Worker restoration was not confirmed")
                if review:
                    await self.sync_review(review)
                    result["reviewEnvironmentUnchanged"] = review["environment_unchanged"]
                result["cleanup"] = "confirmed"
                result["workerRestored"] = True
        except Exception as error:
            result["cleanupError"] = str(error)
            result["cleanup"] = "failed"
            if proc is None:
                result["outcome"] = "spawn_failed"
            if is_review:
                if review:
                    review["failed"] = True
            else:
                self.stopped = True
            if not is_review or review:
                await self.docker("stop", "--time", "0", worker_id, check=False)
            if proc and proc.poll() is None:
                proc.kill()
                await asyncio.to_thread(proc.wait)
        if directory.is_dir():
            temporary = directory / "result.pending"
            temporary.write_text(json.dumps(result), encoding="utf-8")
            temporary.replace(directory / "result.json")

    async def stop_worker(self):
        self.stopping = True
        await self.docker("stop", "--time", "0", self.worker, timeout=30)
        self.stopped = True
        if self.broker:
            await self.broker

    async def export_workspace(self):
        """Copy only regular project files into the original pristine checkout.
        Never copy model-controlled .git, Runtime directories, symlinks or devices.
        The verifier retains its original Git objects and external test material.
        """
        await self.stop_worker()
        candidate = self.root / "candidate.tar"
        await asyncio.to_thread(self.copy_archive_out, self.controller, candidate)
        clean = self.root / "export.tar"
        await asyncio.to_thread(self.filter_archive, self.initial, candidate, clean)
        # Only the disposable, exact /testbed checkout of this bound container.
        # Preserve pristine .git so deletions and modifications remain verifiable.
        cleanup = "find /testbed -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +"
        await self.docker("exec", self.main, "/bin/sh", "-c", cleanup)
        await asyncio.to_thread(self.copy_archive_in, self.main, clean)

    @staticmethod
    def copy_archive_out(container, target, root="/testbed"):
        # Preserve Unix symlinks inside a tar stream; Windows need not create them.
        with target.open("wb") as out, tempfile.TemporaryFile() as err:
            proc = subprocess.Popen(["docker", "cp", f"{container}:{root}/.", "-"], stdout=out, stderr=err)
            deadline = time.monotonic() + 300
            try:
                while proc.poll() is None:
                    if out.tell() > 768 * 1024 * 1024 or time.monotonic() > deadline:
                        raise RuntimeError("Workspace archive exceeded its transfer budget")
                    time.sleep(0.05)
                if proc.returncode:
                    raise RuntimeError("Docker workspace archive transfer failed")
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()

    @staticmethod
    def copy_archive_in(container, source, root="/testbed"):
        with source.open("rb") as stream:
            subprocess.run(["docker", "cp", "-", f"{container}:{root}"], stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, check=True)

    @staticmethod
    def dependency_member(member):
        return any(p in ("node_modules", ".venv", "venv", "dist", "build") for p in Path(member.name).parts)

    @staticmethod
    def dependency_digest(source):
        values = []
        with tarfile.open(source) as archive:
            for member in archive:
                if not SplitBenchmarkEnvironment.dependency_member(member) or member.isdir():
                    continue
                stream = archive.extractfile(member) if member.isfile() else None
                digest = hashlib.sha256()
                if stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                values.append((member.name, member.linkname, digest.hexdigest()))
        return hashlib.sha256(json.dumps(sorted(values)).encode()).hexdigest()

    @staticmethod
    def dependency_archive(source, target):
        count, size = 0, 0
        with tarfile.open(source) as archive, tarfile.open(target, "w") as out:
            for member in archive:
                if not SplitBenchmarkEnvironment.dependency_member(member):
                    continue
                if member.name.startswith("/") or ".." in member.name.split("/") or "\\" in member.name:
                    raise RuntimeError("Unsafe dependency archive path")
                if member.issym():
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname))
                    system_python = re.fullmatch(r"/(?:usr/bin|usr/local/bin)/python[\d.]*", member.linkname)
                    if (resolved.startswith("../") or resolved.startswith("/")) and not system_python:
                        raise RuntimeError("Dependency link escapes review environment")
                elif not member.isfile() and not member.isdir():
                    raise RuntimeError("Unsupported dependency archive entry")
                count += 1
                size += member.size
                if count > 100000 or size > 1024 * 1024 * 1024:
                    raise RuntimeError("Review dependency archive exceeds budget")
                out.addfile(member, archive.extractfile(member) if member.isfile() else None)

    @staticmethod
    def filter_archive(initial, candidate, target, exclude_dependencies=False):
        from pathlib import PurePosixPath
        with tarfile.open(initial) as baseline:
            links = {m.name: m.linkname for m in baseline if m.issym()}
        count, size = 0, 0
        with tarfile.open(candidate) as src, tarfile.open(target, "w") as out:
            for member in src:
                parts = PurePosixPath(member.name).parts
                if not parts or member.name == ".":
                    continue
                if member.name.startswith("/") or ".." in parts or "\\" in member.name:
                    raise RuntimeError("Unsafe workspace archive path")
                if any(p in (".git", ".easycode", ".easy-code-srt-runtime") for p in parts):
                    continue
                # Dependencies stay in the private worker; never copy their links
                # or large contents back into the controller's source snapshot.
                if exclude_dependencies and SplitBenchmarkEnvironment.dependency_member(member):
                    continue
                if member.issym():
                    # Only unchanged, trusted baseline links may reach the verifier.
                    if links.get(member.name) != member.linkname:
                        continue
                elif not member.isfile() and not member.isdir():
                    continue
                count += 1
                size += member.size
                if count > 100000 or size > 512 * 1024 * 1024:
                    raise RuntimeError("Benchmark workspace export exceeds bounded inventory")
                member.uid = member.gid = 0
                member.uname = member.gname = "root"
                member.mode &= 0o777
                out.addfile(member, src.extractfile(member) if member.isfile() else None)

    async def close(self):
        self.stopping = True
        errors = []

        async def remove(*args):
            try:
                outcome = await self.docker(*args, check=False)
                if outcome.returncode and not re.search(r"no such (?:container|volume|image)", outcome.stderr, re.I):
                    errors.append(f"{args[0]} {args[-1]}: {outcome.stderr[-1000:]}")
            except Exception as error:
                errors.append(f"{args[0]} {args[-1]}: {error}")

        await remove("rm", "--force", self.worker)
        for item in self.review_workers.values():
            await remove("rm", "--force", item["name"])
        if self.broker:
            try:
                await self.broker
            except Exception as error:
                errors.append(f"command broker: {error}")
        await remove("rm", "--force", self.controller)
        await remove("volume", "rm", self.volume)
        await remove("volume", "rm", self.git_volume)
        for item in self.review_workers.values():
            await remove("volume", "rm", item["volume"])
        for environment in self.review_images.values():
            await remove("image", "rm", environment["image"])
        await remove("image", "rm", self.image)
        if errors:
            raise RuntimeError("Benchmark cleanup was not confirmed: " + "; ".join(errors))
        self._temp.cleanup()
