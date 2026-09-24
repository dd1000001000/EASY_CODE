"""Recompute live GLM fallback results for base and fine-tuned Laya models."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent
from benchmark_data import QUESTIONS, verified_rows
from run_hybrid_live import GLM_FILE, LOCAL_FILES, THRESHOLD, local_decision  # noqa: E402


def one_vs_rest(rows: list[dict], predictions: dict[str, str], positive: str) -> dict[str, int]:
    result = {"TP": 0, "FP": 0, "TN": 0, "FN": 0}
    for row in rows:
        actual = row["answer"]["decision"] == positive
        predicted = predictions[row["id"]] == positive
        key = ("TP" if actual else "FP") if predicted else ("FN" if actual else "TN")
        result[key] += 1
    return result


def analyze() -> dict:
    rows = verified_rows()
    ids = {row["id"] for row in rows}
    glm_rows = [json.loads(line) for line in GLM_FILE.read_text(encoding="utf-8").splitlines()
                if line.strip()]
    if len(glm_rows) != len(ids) or {item["id"] for item in glm_rows} != ids:
        raise ValueError("Live GLM results must contain all frozen test IDs exactly once")
    if any(item["status"] != "ok" for item in glm_rows):
        raise ValueError("Live GLM results contain failed requests")
    glm = {item["id"]: item["decision"] for item in glm_rows}
    reports = {name: json.loads(path.read_text(encoding="utf-8"))
               for name, path in LOCAL_FILES.items()}
    cases = {name: {item["id"]: item for item in report["cases"]}
             for name, report in reports.items()}
    if any(set(items) != ids for items in cases.values()):
        raise ValueError("Laya reports do not match the frozen test IDs")

    predictions = {"GLM": glm}
    accepted = {}
    for name in ("finetuned", "base"):
        local = {}
        hybrid = {}
        accepted[name] = set()
        for row in rows:
            case_id = row["id"]
            use_laya, label, _ = local_decision(cases[name][case_id])
            local[case_id] = label
            hybrid[case_id] = label if use_laya else glm[case_id]
            if use_laya:
                accepted[name].add(case_id)
        predictions[f"Laya {name}"] = local
        predictions[f"Hybrid {name}"] = hybrid

    tasks = {}
    for task, question in QUESTIONS.items():
        task_rows = [row for row in rows if row["task"] == task]
        task_metrics = {}
        for model, model_predictions in predictions.items():
            confusion = Counter((row["answer"]["decision"], model_predictions[row["id"]])
                                for row in task_rows)
            task_metrics[model] = {
                "correct": sum(count for (actual, predicted), count in confusion.items()
                               if actual == predicted),
                "confusion": {f"{actual}->{predicted}": count
                              for (actual, predicted), count in sorted(confusion.items())},
                "one_vs_rest": {label: one_vs_rest(task_rows, model_predictions, label)
                                for label in question["crit"]},
            }
        tasks[task] = {"cases": len(task_rows), "models": task_metrics}
    return {"threshold": THRESHOLD, "unique_glm_requests": len(glm_rows),
            "glm_requests_including_retries": sum(1 + len(item.get("prior_attempts", []))
                                                  for item in glm_rows),
            "accepted_by_laya": {name: len(values) for name, values in accepted.items()},
            "glm_fallback_per_arm": {name: len(rows) - len(values)
                                     for name, values in accepted.items()},
            "tasks": tasks}


if __name__ == "__main__":
    print(json.dumps(analyze(), ensure_ascii=False, indent=2))
