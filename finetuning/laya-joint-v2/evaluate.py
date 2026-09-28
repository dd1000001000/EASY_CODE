"""Evaluate the published ONNX model on the frozen held-out set (CPU only)."""
from __future__ import annotations
import argparse
import itertools
import json
import sys
import time
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
sys.path.insert(0, str(PROJECT / "resources/laya-decision"))
from runtime import OnnxAgent, build_sequence, pack_inputs, probabilities, file_hash

DEFAULT_MODEL = PROJECT / "model-weights/laya-multilingual/joint-v2/model"
QUESTIONS = json.loads((PROJECT / "resources/laya-decision/questions.json").read_text(encoding="utf-8"))

def evaluate(agent, rows, batch_size=1):
    work = [(row, list(order)) for row in rows for order in
            itertools.permutations(range(len(QUESTIONS[row["task"]]["crit"])))]
    cases, loss, times = {}, 0., []
    for start in range(0, len(work), batch_size):
        portion = work[start:start + batch_size]
        inputs = pack_inputs([build_sequence(agent.tok, row["user"], QUESTIONS[row["task"]],
                                             agent.cfg["max_len"], agent.cfg["head_max_len"], order)
                              for row, order in portion], agent.tok.pad_token_id)
        began = time.perf_counter()
        logits, _ = agent.infer(inputs)
        times.append((time.perf_counter() - began) * 1000)
        for (row, order), scores in zip(portion, logits, strict=True):
            labels = list(QUESTIONS[row["task"]]["crit"])
            p = probabilities(scores[:len(order)])
            expected = row["answer"]["decision"]
            loss -= float(np.log(max(p[order.index(labels.index(expected))], 1e-300)))
            item = cases.setdefault(row["id"], {"id": row["id"], "task": row["task"],
                                               "expected": expected, "orders": []})
            item["orders"].append({"order": [labels[index] for index in order],
                                   "predicted": labels[order[int(p.argmax())]],
                                   "probabilities": {labels[index]: float(prob) for index, prob in zip(order, p, strict=True)}})
        if start % 100 == 0:
            print(f"ONNX evaluation: {min(start + batch_size, len(work))}/{len(work)}", file=sys.stderr, flush=True)
    by_task = {}
    for task, question in QUESTIONS.items():
        subset = [case for case in cases.values() if case["task"] == task]
        if not subset:
            continue
        matrix = {actual: {pred: 0 for pred in question["crit"]} for actual in question["crit"]}
        for case in subset:
            for order in case["orders"]:
                matrix[case["expected"]][order["predicted"]] += 1
        total = sum(sum(row.values()) for row in matrix.values())
        correct = sum(matrix[label][label] for label in matrix)
        by_task[task] = {"cases": len(subset), "correct_orders": correct, "total_orders": total,
                         "accuracy": correct / total, "confusion": matrix,
                         "all_orders_correct": sum(all(order["predicted"] == case["expected"] for order in case["orders"]) for case in subset),
                         "inconsistent_cases": sum(len({order["predicted"] for order in case["orders"]}) > 1 for case in subset)}
    return {"loss": loss / len(work), "by_task": by_task, "cases": list(cases.values()),
            "forward_ms": {"median": float(np.median(times)), "p95": float(np.percentile(times, 95))}}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--batch-size", type=int, default=1)
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error("batch size must be positive")
    expected = json.loads((HERE / "data/manifest.json").read_text(encoding="utf-8"))["splits"]["test"]
    path = HERE / "data/test.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if file_hash(path) != expected["sha256"] or len(rows) != expected["rows"]:
        raise ValueError("Held-out snapshot mismatch")
    began = time.perf_counter()
    agent = OnnxAgent(args.model)
    result = {"backend": "onnx-fp32-cpu", "model_sha256": agent.model_sha256,
              "dataset_sha256": file_hash(path), "test_rows": len(rows),
              "batch_size": args.batch_size, "load_seconds": time.perf_counter() - began,
              **evaluate(agent, rows, args.batch_size)}
    if args.output:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key != "cases"}, indent=2))

if __name__ == "__main__":
    main()
