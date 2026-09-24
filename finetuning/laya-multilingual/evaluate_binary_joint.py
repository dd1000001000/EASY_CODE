"""Evaluate all three decision tasks with shuffled and exhaustive answer orders."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import random
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from v10_contract import QUESTIONS, case_question, read_rows
from v10_snapshot import DEFAULT_OUTPUT, PROTOCOL, verify
from v10_training_support import MODEL_ROOT
from train_binary_joint import encode_case


def evaluate(model_path: Path, data_root: Path, split: str, batch_size: int, seed: int) -> dict:
    import laya
    import torch
    from laya.common import collate_items

    protocol = json.loads((data_root / "manifest.json").read_text(encoding="utf-8"))["protocol"]
    if protocol != PROTOCOL or split not in {"validation", "test"}:
        raise ValueError("Only V10 validation or test may be evaluated")
    manifest = verify(output=data_root)
    split_hash = manifest["splits"][split]["sha256"]
    rows = read_rows(data_root / f"{split}.jsonl")
    source_hashes = {"manifest.json": hashlib.sha256(
        (data_root / "manifest.json").read_bytes()).hexdigest(),
        f"{split}.jsonl": split_hash}
    agent = laya.load(str(model_path), device="cuda")
    if agent.device.type != "cuda":
        raise RuntimeError("CUDA GPU model placement failed")
    agent.model.eval()
    started = time.monotonic()
    records = {row["id"]: {"id": row["id"], "task": row["task"],
                           "expected": row["answer"]["decision"], "orders": []}
               for row in rows}
    work = []
    for row in rows:
        permutations = list(itertools.permutations(range(len(case_question(row)["crit"]))))
        # A per-case seed makes the scored first order reproducible and
        # independent of dataset file order. Remaining orders audit stability.
        random.Random(f"{seed}:{row['id']}").shuffle(permutations)
        for order in permutations:
            work.append((row, list(order), encode_case(agent.tok, agent.cfg, row, list(order))))
    with torch.inference_mode():
        for start in range(0, len(work), batch_size):
            part = work[start:start + batch_size]
            items = [item for _, _, item in part]
            batch = collate_items([[item] for item in items], agent.tok.pad_token_id)
            tensor = {key: value.to(agent.device) for key, value in batch.items()
                      if key in {"input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"}}
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits, _ = agent.model(**tensor)
            probabilities = torch.softmax(logits.float(), -1).cpu().tolist()
            for (row, order, _), distribution in zip(part, probabilities, strict=True):
                labels = list(QUESTIONS[row["task"]]["crit"])
                distribution = distribution[:len(order)]
                if len(distribution) != len(order) or not all(math.isfinite(p) for p in distribution):
                    raise ValueError(f"{row['id']}: invalid model distribution")
                semantic = {labels[canonical]: distribution[position]
                            for position, canonical in enumerate(order)}
                predicted = max(semantic, key=semantic.get)
                records[row["id"]]["orders"].append({"order": [labels[i] for i in order],
                                                     "predicted": predicted,
                                                     "probabilities": semantic})
    grouped = defaultdict(list)
    for record in records.values():
        grouped[record["task"]].append(record)
    metrics = {}
    for task, group in grouped.items():
        first_correct = sum(record["orders"][0]["predicted"] == record["expected"]
                            for record in group)
        total_orders = sum(len(record["orders"]) for record in group)
        correct_orders = sum(sum(order["predicted"] == record["expected"]
                                 for order in record["orders"]) for record in group)
        confusion = Counter((record["expected"], record["orders"][0]["predicted"])
                            for record in group)
        metrics[task] = {"cases": len(group), "shuffled_order_correct": first_correct,
                         "shuffled_order_accuracy": first_correct / len(group),
                         "correct_across_orders": correct_orders,
                         "total_orders": total_orders,
                         "accuracy_across_orders": correct_orders / total_orders,
                         "cases_with_changed_answer": sum(len({o["predicted"] for o in record["orders"]}) > 1
                                                          for record in group),
                         "cases_correct_in_all_orders": sum(all(o["predicted"] == record["expected"]
                                                             for o in record["orders"])
                                                          for record in group),
                         "confusion_shuffled": [
                             {"expected": expected, "predicted": predicted, "count": count}
                             for (expected, predicted), count in sorted(confusion.items())]}
    approval = grouped["approval"]
    risky = [record for record in approval if record["expected"] == "NEED_REVIEW"]
    safe = [record for record in approval if record["expected"] == "AUTO_ALLOW"]
    metrics["approval"].update({
        "risky_cases": len(risky), "safe_cases": len(safe),
        "unsafe_auto_shuffled_order": sum(record["orders"][0]["predicted"] == "AUTO_ALLOW"
                                           for record in risky),
        "unsafe_auto_any_order": sum(any(order["predicted"] == "AUTO_ALLOW"
                                         for order in record["orders"]) for record in risky),
        "safe_auto_shuffled_order": sum(record["orders"][0]["predicted"] == "AUTO_ALLOW"
                                        for record in safe),
        "safe_auto_all_orders": sum(all(order["predicted"] == "AUTO_ALLOW"
                                        for order in record["orders"]) for record in safe),
    })
    pairs = defaultdict(list)
    for record in approval:
        pairs[record["id"][:-1]].append(record)
    contrasts = [pair for pair in pairs.values() if len(pair) == 2 and
                 {record["expected"] for record in pair} == {"AUTO_ALLOW", "NEED_REVIEW"}]
    metrics["approval"]["contrasting_pairs"] = len(contrasts)
    metrics["approval"]["pairs_both_correct_shuffled"] = sum(
        all(record["orders"][0]["predicted"] == record["expected"] for record in pair)
        for pair in contrasts)
    metrics["approval"]["pairs_both_correct_all_orders"] = sum(
        all(all(order["predicted"] == record["expected"] for order in record["orders"])
            for record in pair) for pair in contrasts)
    ranked_shuffled = 0
    ranked_all_orders = 0
    for pair in contrasts:
        safe = next(record for record in pair if record["expected"] == "AUTO_ALLOW")
        risky = next(record for record in pair if record["expected"] == "NEED_REVIEW")
        safe_scores = [order["probabilities"]["AUTO_ALLOW"] for order in safe["orders"]]
        risky_scores = [order["probabilities"]["AUTO_ALLOW"] for order in risky["orders"]]
        ranked_shuffled += int(safe_scores[0] > risky_scores[0])
        ranked_all_orders += int(min(safe_scores) > max(risky_scores))
    metrics["approval"]["pairs_safe_allow_score_above_risky_shuffled"] = ranked_shuffled
    metrics["approval"]["pairs_safe_allow_score_above_risky_all_orders"] = ranked_all_orders
    return {"evaluated_at_utc": datetime.now(timezone.utc).isoformat(),
            "model": str(model_path), "dataset": str(data_root), "split": split, "seed": seed,
            "source_sha256": source_hashes,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "metrics": metrics, "cases": list(records.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=MODEL_ROOT / "finetuned")
    parser.add_argument("--data-root", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--split", choices=("validation", "test"), default="test")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--seed", type=int, default=271828)
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error("batch size must be positive")
    if args.output.exists():
        raise FileExistsError(f"Refusing to overwrite evaluation report: {args.output}")
    result = evaluate(args.model, args.data_root, args.split, args.batch_size, args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    print(json.dumps({"report": str(args.output), "metrics": result["metrics"]},
                     ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
