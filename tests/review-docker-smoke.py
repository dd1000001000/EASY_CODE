"""Opt-in offline integration test; requires an already-present Python image.

Run: python tests/review-docker-smoke.py --image <local-image>
Only UUID-named resources created here are removed. Never pulls an image.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
import uuid

spec = importlib.util.spec_from_file_location("split_environment", Path(__file__).parents[1] / "benchmarks/swebench_verified/split_environment.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


async def main(image):
    split = module.SplitBenchmarkEnvironment(None)
    try:
        await split.docker("image", "inspect", image)
        await split.docker("volume", "create", split.volume)
        for name in (split.worker, split.controller):
            mount = ["--mount", f"type=volume,source={split.volume},target=/testbed"] if name == split.worker else []
            await split.docker("create", "--pull", "never", "--name", name, "--network", "none", "--ipc", "private",
                "--security-opt", "no-new-privileges:true", *mount,
                "--entrypoint", "/bin/sh", image, "-c", "while :; do sleep 3600; done")
            await split.docker("start", name)
        split.worker_id = json.loads((await split.docker("inspect", split.worker)).stdout)[0]["Id"]
        review_id = "review_" + str(uuid.uuid4())
        roots = [f"/tmp/easy-code-{review_id}/{actor}" for actor in ("author", "reviewer")]
        await split.docker("exec", split.worker_id, "python", "-c",
            "from pathlib import Path; Path('/opt/review-runtime-marker').write_text('installed-after-worker-start'); "
            "p=Path('/testbed/node_modules/review-smoke'); p.mkdir(parents=True,exist_ok=True); (p/'index.js').write_text('42')")
        await split.docker("exec", split.controller, "python", "-c",
            "from pathlib import Path; import sys; "
            "[(Path(p).mkdir(parents=True), (Path(p)/'review_source.py').write_text('assert True')) for p in sys.argv[1:]]", *roots)
        participants = []
        for actor, root in zip(("author", "reviewer"), roots):
            item = await split.review_worker({"id": review_id, "actor": actor, "root": root})
            participants.append(item)
            result = await split.docker("exec", item["id"], "python", "-c",
                "from pathlib import Path; import socket, multiprocessing; "
                "assert Path('/opt/review-runtime-marker').read_text()=='installed-after-worker-start'; "
                "assert Path('/testbed/node_modules/review-smoke/index.js').read_text()=='42'; "
                "assert Path('/testbed/review_source.py').exists(); "
                "assert not Path('/opt/easy-code-command-bridge').exists(); "
                "assert not Path('/var/run/docker.sock').exists(); "
                "a,b=socket.socketpair(); a.close(); b.close(); multiprocessing.Lock(); print('environment-ok')")
            assert "environment-ok" in result.stdout
            await split.sync_review(item)
            assert item["environment_unchanged"]
            info = json.loads((await split.docker("inspect", item["id"])).stdout)[0]
            assert info["HostConfig"]["ReadonlyRootfs"] and info["HostConfig"]["NetworkMode"] == "none"
        await split.docker("exec", participants[0]["id"], "python", "-c",
            "from pathlib import Path; Path('/testbed/node_modules/review-smoke/index.js').write_text('tampered')")
        await split.sync_review(participants[0])
        assert not participants[0]["environment_unchanged"]
        for name in (participants[1]["id"], split.worker_id):
            await split.docker("exec", name, "python", "-c",
                "from pathlib import Path; assert Path('/testbed/node_modules/review-smoke/index.js').read_text()=='42'")
        print("PASS: current worker environment, private dependencies, AF_UNIX/SemLock, readonly root, no network, tamper detection")
    finally:
        await split.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    asyncio.run(main(parser.parse_args().image))
