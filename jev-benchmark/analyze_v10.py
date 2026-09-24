"""Summarize GLM V10 results and the fixed Laya confidence gates.

Approval and delivery gates: 0.90. Route has no gate.
An accepted Laya answer must also be unchanged across all option orders; its
gate score is the minimum probability of that answer across those orders.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path


from benchmark_data import QUESTIONS, TEST_SHA256, verified_rows


GLM_RESULTS = Path(__file__).with_name("results.jsonl")
LAYA_REPORT = Path(__file__).with_name("hybrid_laya_finetuned.json")
GATES = {"approval": 0.90, "delivery": 0.90}


def one_vs_rest(rows: list[dict], predictions: dict[str, str], positive: str) -> dict[str, int]:
    counts = {"TP": 0, "FP": 0, "TN": 0, "FN": 0}
    for row in rows:
        actual_positive = row["answer"]["decision"] == positive
        predicted_positive = predictions[row["id"]] == positive
        bucket = ("TP" if actual_positive else "FP") if predicted_positive else (
            "FN" if actual_positive else "TN")
        counts[bucket] += 1
    return counts


def main() -> None:
    rows = verified_rows()
    truth = {row["id"]: row for row in rows}
    glm_rows = [json.loads(line) for line in GLM_RESULTS.read_text(encoding="utf-8").splitlines()
                if line.strip()]
    if len(glm_rows) != len(truth) or {row["id"] for row in glm_rows} != set(truth):
        raise ValueError("GLM results do not cover each frozen test ID exactly once")
    if any(row["status"] != "ok" for row in glm_rows):
        raise ValueError("GLM results contain failed or unparseable responses")
    if any(row["expected"] != truth[row["id"]]["answer"]["decision"] for row in glm_rows):
        raise ValueError("GLM result labels differ from the frozen test")
    glm = {row["id"]: row for row in glm_rows}
    laya_data = json.loads(LAYA_REPORT.read_text(encoding="utf-8"))
    laya = {row["id"]: row for row in laya_data["cases"]}
    if set(laya) != set(truth):
        raise ValueError("Laya report and frozen test IDs do not match")

    summary = {
        "model": "glm-5.3-flash",
        "dataset_sha256": TEST_SHA256,
        "total_cases": len(rows),
        "total_prompt_tokens": sum(row.get("prompt_tokens") or 0 for row in glm_rows),
        "total_completion_tokens": sum(row.get("completion_tokens") or 0 for row in glm_rows),
        "total_request_seconds": round(sum(row["elapsed_seconds"] for row in glm_rows), 2),
        "tasks": {},
    }
    for task in QUESTIONS:
        task_rows = [row for row in rows if row["task"] == task]
        glm_predictions = {row["id"]: glm[row["id"]]["decision"] for row in task_rows}
        laya_predictions = {row["id"]: laya[row["id"]]["orders"][0]["predicted"]
                            for row in task_rows}
        hybrid_predictions = dict(glm_predictions)
        glm_correct = 0
        laya_correct = 0
        glm_confusion = Counter()
        laya_confusion = Counter()
        for row in task_rows:
            case_id = row["id"]
            expected = row["answer"]["decision"]
            glm_pred = glm[case_id]["decision"]
            laya_pred = laya[case_id]["orders"][0]["predicted"]
            glm_correct += glm_pred == expected
            laya_correct += laya_pred == expected
            glm_confusion[(expected, glm_pred)] += 1
            laya_confusion[(expected, laya_pred)] += 1
        task_summary = {
            "cases": len(task_rows),
            "glm_correct": glm_correct,
            "laya_correct": laya_correct,
            "glm_confusion": {f"{a}->{b}": n for (a, b), n in sorted(glm_confusion.items())},
            "laya_confusion": {f"{a}->{b}": n for (a, b), n in sorted(laya_confusion.items())},
        }
        if task in GATES:
            threshold = GATES[task]
            accepted = []
            fallback = []
            hybrid_confusion = Counter()
            accepted_scores = []
            for row in task_rows:
                case_id = row["id"]
                expected = row["answer"]["decision"]
                orders = laya[case_id]["orders"]
                predictions = {order["predicted"] for order in orders}
                stable = len(predictions) == 1
                label = orders[0]["predicted"]
                score = min(order["probabilities"][label] for order in orders)
                use_laya = stable and score >= threshold
                if use_laya:
                    accepted.append((expected, label))
                    accepted_scores.append(score)
                else:
                    fallback.append((expected, glm[case_id]["decision"]))
                decision = label if use_laya else glm[case_id]["decision"]
                hybrid_predictions[case_id] = decision
                hybrid_confusion[(expected, decision)] += 1
            task_summary["gate"] = {
                "threshold": threshold,
                "requires_all_order_agreement": True,
                "accepted_by_laya": len(accepted),
                "accepted_correct": sum(a == b for a, b in accepted),
                "accepted_errors": sum(a != b for a, b in accepted),
                "accepted_min_score": min(accepted_scores) if accepted_scores else None,
                "fallback_to_glm": len(fallback),
                "fallback_glm_correct": sum(a == b for a, b in fallback),
                "hybrid_correct": sum(n for (a, b), n in hybrid_confusion.items()
                                      if a == b),
                "hybrid_confusion": {f"{a}->{b}": n for (a, b), n in sorted(hybrid_confusion.items())},
            }
        task_summary["one_vs_rest"] = {
            model: {label: one_vs_rest(task_rows, predictions, label)
                    for label in QUESTIONS[task]["crit"]}
            for model, predictions in (("glm", glm_predictions),
                                       ("laya", laya_predictions),
                                       ("hybrid", hybrid_predictions))
        }
        summary["tasks"][task] = task_summary
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
