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

    async def execute_worker(self, directory):
        result = {"exitCode": 125}
        proc = None
        try:
            data = json.loads((directory / "request.json").read_text(encoding="utf-8"))
            if (data.get("version") != 1 or not isinstance(data.get("args"), list) or
                not isinstance(data.get("program"), str) or not data["program"] or any(c in data["program"] for c in "\0\r\n") or
                not isinstance(data.get("cwd"), str) or not data["cwd"].startswith("/") or
                len(data["args"]) > 256 or any(not isinstance(a, str) or "\0" in a for a in data["args"])):
                raise RuntimeError("Malformed controller command")
            if self.stopped or self.stopping:
                raise RuntimeError("Benchmark worker has stopped")
            # Clear image-level Git helper/credential env too, not just the
            # controller's environment. Docker otherwise inherits image ENV.
            argv = ["docker", "exec", "--workdir", data["cwd"], self.worker_id, "/usr/bin/env", "-i"]
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
                        await self.docker("stop", "--time", "0", self.worker_id)
                        if oversized:
                            result["error"] = "Command output exceeded the 32 MiB bridge limit"
                        break
                    await asyncio.sleep(0.05)
                result["exitCode"] = await asyncio.to_thread(proc.wait, 15)
            # Docker owns the cgroup: restarting kills even detached descendants.
            # The writable layer and /testbed persist; process state does not.
            if not self.stopping:
                await self.docker("restart", "--time", "0", self.worker_id, timeout=30)
        except Exception as error:
            result["error"] = str(error)
            self.stopped = True
            await self.docker("stop", "--time", "0", self.worker, check=False)
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
    def copy_archive_out(container, target):
        # Preserve Unix symlinks inside a tar stream; Windows need not create them.
        with target.open("wb") as out, tempfile.TemporaryFile() as err:
            proc = subprocess.Popen(["docker", "cp", f"{container}:/testbed/.", "-"], stdout=out, stderr=err)
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
    def copy_archive_in(container, source):
        with source.open("rb") as stream:
            subprocess.run(["docker", "cp", "-", f"{container}:/testbed"], stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, check=True)

    @staticmethod
    def filter_archive(initial, candidate, target):
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
        if self.broker:
            try:
                await self.broker
            except Exception as error:
                errors.append(f"command broker: {error}")
        await remove("rm", "--force", self.controller)
        await remove("volume", "rm", self.volume)
        await remove("volume", "rm", self.git_volume)
        await remove("image", "rm", self.image)
        if errors:
            raise RuntimeError("Benchmark cleanup was not confirmed: " + "; ".join(errors))
        self._temp.cleanup()
