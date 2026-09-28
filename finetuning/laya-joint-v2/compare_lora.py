"""Archive a LoRA experiment and compare both ONNX models on 200 worker cases."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "resources/laya-decision"))
from runtime import OnnxAgent, file_hash
from worker import decide
from compare_backends import compare


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reference-model", type=Path, required=True,
                        help="Original full-SFT ONNX directory (not the current LoRA release)")
    parser.add_argument("--reference-evaluation", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Use a new output directory")
    report = json.loads((args.run / "report.json").read_text(encoding="utf-8"))
    if report["status"] != "complete" or report["method"] != "lora":
        raise ValueError("Expected a completed LoRA run")
    reference_path = args.reference_evaluation
    reference = json.loads(reference_path.read_text(encoding="utf-8"))
    reference_hash = file_hash(args.reference_model / "model.onnx")
    if reference_hash != reference["model_sha256"]:
        raise ValueError("Reference weights do not match reference evaluation")
    if reference_hash == file_hash(args.run / "model/model.onnx"):
        raise ValueError("Reference and candidate must be different models")
    comparison = compare(reference, {"cases": report["test_cases"]})
    benchmark_path = ROOT / "laya-bench mark/cases.jsonl"
    rows = [json.loads(line) for line in benchmark_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(rows) != 200 or len({row["id"] for row in rows}) != 200:
        raise ValueError("Expected 200 unique frozen worker cases")
    worker_results, worker_summary = {}, {}
    for name, model in (("full_sft", args.reference_model),
                        ("lora", args.run / "model")):
        agent = OnnxAgent(model)
        results = []
        for index, row in enumerate(rows, 1):
            started = time.perf_counter()
            result = decide(agent, row)
            results.append({"id": row["id"], "task": row["task"], "expected": row["expected"],
                            "predicted": result["decision"], "scores": result["scores"],
                            "milliseconds": (time.perf_counter() - started) * 1000})
            if index % 50 == 0:
                print(f"{name}: {index}/200", flush=True)
        worker_results[name] = results
        worker_summary[name] = {"model_sha256": agent.model_sha256}
        for task in ("route", "delivery"):
            subset = [row for row in results if row["task"] == task]
            correct = sum(row["expected"] == row["predicted"] for row in subset)
            worker_summary[name][task] = {"correct": correct, "total": len(subset),
                                          "accuracy": correct / len(subset)}
        del agent
    summary = {"method": "encoder LoRA plus fully trained choice head",
               "reference": "Archived full-SFT ONNX; saved 972-order evaluation",
               "held_out": {"full_sft": reference["by_task"], "lora": report["held_out_test"]["trained"]},
               "parameter_counts": report["parameter_counts"],
               "training_resources": report["training_resources"],
               "selected_epochs": report["selected_epochs"], "comparison": comparison,
               "worker_benchmark": worker_summary, "worker_cases_sha256": file_hash(benchmark_path),
               "experiment_model": str(args.run / "model"),
               "adapter_bytes": sum(path.stat().st_size for path in (args.run / "adapter").rglob("*") if path.is_file()),
               "onnx_bytes": (args.run / "model/model.onnx").stat().st_size,
               "limitations": ["Single seed and fixed LoRA configuration; not a hyperparameter sweep.",
                               "Historical full SFT training used a different PyTorch version; training time is not directly comparable.",
                               "Both final models are evaluated in CPU FP32 ONNX; LoRA is not quantization.",
                               "The 200 worker cases are a subset of the held-out set, not an independent dataset.",
                               "This comparison does not replace application weights or run cloud API evaluations."]}
    args.output.mkdir(parents=True)
    for filename, value in (("training-report.json", report), ("summary.json", summary),
                            ("worker-results.json", worker_results)):
        (args.output / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"worker_benchmark": worker_summary,
                      "held_out": summary["held_out"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
