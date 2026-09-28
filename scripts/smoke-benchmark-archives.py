"""Exercise the real Docker archive path offline, without models or user jobs."""
import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import uuid
import sys


def docker(*args):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="An already installed task image with /testbed")
    parser.add_argument("--parallel", type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.parallel <= 4:
        parser.error("parallel must be 1..4")
    source_file = Path(__file__).resolve().parents[1] / "benchmarks/swebench_verified/split_environment.py"
    sys.path.insert(0, str(source_file.parents[2]))
    spec = importlib.util.spec_from_file_location("archive_smoke_split", source_file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    split = module.SplitBenchmarkEnvironment
    prefix = "easy-code-archive-smoke-" + uuid.uuid4().hex
    source = prefix + "-source"
    docker("create", "--name", source, "--network", "none", args.image)

    def copy(index):
        target = prefix + f"-target-{index}"
        workspace, git = target + "-workspace", target + "-git"
        try:
            docker("volume", "create", workspace)
            docker("volume", "create", git)
            docker("create", "--name", target, "--network", "none",
                   "--mount", f"type=volume,source={workspace},target=/testbed",
                   "--mount", f"type=volume,source={git},target=/testbed/.git", args.image)
            with tempfile.TemporaryDirectory(prefix="easy-code-archive-probe-") as directory:
                archive = Path(directory) / "workspace.tar"
                split.copy_archive_out(source, archive)
                with tarfile.open(archive, "r:") as parsed:
                    count = sum(1 for _ in parsed)
                split.copy_archive_in(target, archive)
                roundtrip = Path(directory) / "roundtrip.tar"
                split.copy_archive_out(target, roundtrip)
                # Content-based equality, independent of tar header ordering/mtime.
                def manifest(filename):
                    import hashlib
                    with tarfile.open(filename, "r:") as parsed:
                        return {m.name: hashlib.sha256(parsed.extractfile(m).read()).hexdigest()
                                for m in parsed if m.isfile()}
                assert manifest(archive) == manifest(roundtrip), "Roundtrip file contents differ"
                return {"copy": index, "entries": count, "bytes": archive.stat().st_size, "ok": True}
        except Exception as error:
            detail = getattr(error, "stderr", b"") or ""
            if isinstance(detail, bytes):
                detail = detail.decode("utf-8", "replace")
            return {"copy": index, "ok": False, "error": str(error), "stderr": detail}
        finally:
            subprocess.run(["docker", "rm", "-f", target], capture_output=True, timeout=120)
            docker("volume", "rm", workspace, git)

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
            results = list(pool.map(copy, range(args.parallel)))
        print(json.dumps(results, indent=2))
        if not all(result["ok"] for result in results):
            raise SystemExit(1)
    finally:
        docker("rm", "-f", source)


if __name__ == "__main__":
    main()
