"""Compare matching frozen evaluations, including option order and probabilities."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def flatten(report):
    rows = report.get("results")
    if rows is None:
        rows = [{"id": case["id"], "labels": order["order"], **order}
                for case in report["cases"] for order in case["orders"]]
    result = {}
    for row in rows:
        key = (row["id"], tuple(row["labels"]))
        if key in result:
            raise ValueError(f"Duplicate evaluation: {key}")
        values = row["probabilities"]
        result[key] = (row["predicted"], values if isinstance(values, dict) else dict(zip(row["labels"], values, strict=True)))
    return result


def compare(reference, candidate):
    before, after = flatten(reference), flatten(candidate)
    if not before or before.keys() != after.keys():
        raise ValueError("Evaluations do not cover the same cases and option orders")
    differences = [key for key in before if before[key][0] != after[key][0]]
    maximum = max(abs(before[key][1][label] - after[key][1][label])
                  for key in before for label in key[1])
    return {"evaluations": len(before), "changed_decisions": len(differences),
            "max_probability_difference": maximum,
            "changed_cases": [{"id": key[0], "order": key[1]} for key in differences]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    args = parser.parse_args()
    result = compare(json.loads(args.reference.read_text(encoding="utf-8")),
                     json.loads(args.candidate.read_text(encoding="utf-8")))
    print(json.dumps(result, indent=2))
    raise SystemExit(int(result["changed_decisions"] != 0))
