"""Verify the pinned 50-task manifest against local Parquet files.

This command performs no downloads. Put both datasets on the F: drive (or any
other local disk) and pass their paths explicitly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pyarrow.parquet as parquet


EXPECTED_MINI_SHA256 = (
    "f9ba19dea78884f1081355d2d8afb671899981f24180aa0c4c1aa14d2c23e855"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def instance_ids(path: Path) -> list[str]:
    table = parquet.read_table(path, columns=["instance_id"])
    return [str(value) for value in table.column("instance_id").to_pylist()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mini-parquet", type=Path, required=True)
    parser.add_argument("--official-parquet", type=Path, required=True)
    args = parser.parse_args()

    manifest_path = Path(__file__).with_name("subset-50.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = [str(value) for value in manifest["instance_ids"]]

    if len(expected) != 50 or len(set(expected)) != 50:
        raise SystemExit("manifest must contain exactly 50 unique IDs")

    mini_hash = sha256_file(args.mini_parquet)
    if mini_hash != EXPECTED_MINI_SHA256:
        raise SystemExit(
            f"mini parquet SHA-256 mismatch: expected {EXPECTED_MINI_SHA256}, got {mini_hash}"
        )

    mini_ids = instance_ids(args.mini_parquet)
    if mini_ids != expected:
        raise SystemExit("manifest IDs/order do not match the pinned mini parquet")

    official_ids = set(instance_ids(args.official_parquet))
    missing = [value for value in expected if value not in official_ids]
    if missing:
        raise SystemExit(f"{len(missing)} mini task(s) are absent from official data: {missing}")

    print("OK: manifest, mini parquet, and official SWE-bench Verified data agree.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

