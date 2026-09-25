"""Evaluate the retained fine-tuned checkpoint without downloading the base model."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import support

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
DEFAULT_MODEL = PROJECT / "model-weights/laya-multilingual/joint-v2/model"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    args = parser.parse_args()

    manifest = json.loads((HERE / "data/manifest.json").read_text(encoding="utf-8"))
    test_path = HERE / "data/test.jsonl"
    expected = manifest["splits"]["test"]
    if support.digest(test_path) != expected["sha256"]:
        raise ValueError("Held-out test snapshot hash mismatch")
    rows = support.rows_from(test_path)
    if len(rows) != expected["rows"]:
        raise ValueError("Held-out test row count mismatch")

    import laya
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("This evaluation script requires CUDA")
    checkpoint = args.model.resolve()
    if not (checkpoint / "model.safetensors").is_file():
        raise FileNotFoundError(f"Fine-tuned checkpoint not found: {checkpoint}")
    agent = laya.load(str(checkpoint), device="cuda")
    result = support.evaluate(agent, rows)
    by_task = {}
    for task, labels in (("route", ("DIRECT", "PLAN", "CODE")),
                         ("delivery", ("RELEASE", "CHALLENGE"))):
        cases = [case for case in result["cases"] if case["task"] == task]
        matrix = {actual: {predicted: 0 for predicted in labels} for actual in labels}
        for case in cases:
            for order in case["orders"]:
                matrix[case["expected"]][order["predicted"]] += 1
        by_task[task] = {**result["by_task"][task], "confusion": matrix}
    print(json.dumps({"model": str(checkpoint), "test_rows": len(rows),
                      "by_task": by_task}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
