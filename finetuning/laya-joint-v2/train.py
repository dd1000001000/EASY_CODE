"""Jointly train route and delivery choices in one upstream Laya model."""
from __future__ import annotations

import argparse
import json
import random
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
DATA = HERE / "data"
DEFAULT_OUTPUT = PROJECT / "model-weights/laya-multilingual/joint-v2"
import support as common  # noqa: E402


def load_splits():
    manifest = json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))
    if manifest["protocol"] != "laya-joint-v2-route-delivery":
        raise ValueError("Unexpected joint dataset protocol")
    splits = {}
    for name in ("fit", "validation", "test"):
        path = DATA / f"{name}.jsonl"
        if common.digest(path) != manifest["splits"][name]["sha256"]:
            raise ValueError(f"Changed {name} snapshot")
        splits[name] = common.rows_from(path)
        if len(splits[name]) != manifest["splits"][name]["rows"]:
            raise ValueError(f"Changed {name} count")
    if (len(splits["fit"]), len(splits["validation"]), len(splits["test"])) != (995, 110, 276):
        raise ValueError("4:1 joint split changed")
    if len({row["id"] for part in splits.values() for row in part}) != 1381:
        raise ValueError("Split ID overlap")
    if any(row["task"] not in ("route", "delivery") or
           row["answer"]["decision"] not in common.QUESTIONS[row["task"]]["crit"]
           for part in splits.values() for row in part):
        raise ValueError("Unsupported task or label")
    return splits, manifest


def metrics(result: dict) -> dict:
    output = {}
    for task in ("route", "delivery"):
        labels = list(common.QUESTIONS[task]["crit"])
        cases = [case for case in result["cases"] if case["task"] == task]
        matrix = {expected: {predicted: 0 for predicted in labels} for expected in labels}
        for case in cases:
            for order in case["orders"]:
                matrix[case["expected"]][order["predicted"]] += 1
        output[task] = {**result["by_task"][task], "confusion": matrix,
                        "per_class_accuracy": {
                            label: matrix[label][label] / sum(matrix[label].values())
                            for label in labels}}
    output["macro_accuracy"] = (output["route"]["accuracy"] +
                                output["delivery"]["accuracy"]) / 2
    output["macro_all_orders_correct_rate"] = sum(
        output[task]["all_orders_correct"] / output[task]["cases"]
        for task in ("route", "delivery")) / 2
    output["loss"] = result["loss"]
    return output


def fit_epoch(agent, optimizer, parameters, rows: list[dict], seed: int, epoch: int) -> float:
    """One shared-head update stream with equal total weight for both tasks."""
    import torch
    import torch.nn.functional as F

    totals = Counter(row["task"] for row in rows)
    weights = {task: len(rows) / (2 * count) for task, count in totals.items()}
    agent.model.train()
    shuffled = list(rows)
    random.Random(seed + epoch * 1009).shuffle(shuffled)
    order_rng = random.Random(seed + epoch * 1013)
    cumulative = 0.0
    for start in range(0, len(shuffled), 16):
        window = shuffled[start:start + 16]
        optimizer.zero_grad(set_to_none=True)
        for offset in range(0, len(window), 4):
            portion = window[offset:offset + 4]
            orders = [order_rng.sample(
                range(len(common.QUESTIONS[row["task"]]["crit"])),
                len(common.QUESTIONS[row["task"]]["crit"])) for row in portion]
            batch = common.model_batch(agent, portion, orders)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = common.logits_for(agent.model, batch)
                per_row = F.cross_entropy(logits, batch["label"], reduction="none")
                weight = torch.tensor([weights[row["task"]] for row in portion],
                                      dtype=per_row.dtype, device=per_row.device)
                weighted = (per_row * weight).sum() / len(portion)
            if not torch.isfinite(weighted):
                raise RuntimeError(f"Non-finite loss in epoch {epoch}")
            (weighted * len(portion) / len(window)).backward()
            cumulative += float(weighted.detach()) * len(portion)
        torch.nn.utils.clip_grad_norm_(parameters, 1.0, error_if_nonfinite=True)
        optimizer.step()
    return cumulative / len(shuffled)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--max-epochs", type=int, default=8)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--encoder-lr", type=float, default=2e-6)
    parser.add_argument("--head-lr", type=float, default=1e-5)
    parser.add_argument("--seed", type=int, default=20260925)
    args = parser.parse_args()
    output = args.output.resolve()
    if args.max_epochs < 1 or args.patience < 1 or output.exists():
        parser.error("Use positive limits and an unused output directory")
    source = common.SOURCE.resolve()
    expected_hash = json.loads((HERE / "source.json").read_text(encoding="utf-8"))[
        "model_sha256"]
    if common.digest(source / "model.safetensors") != expected_hash:
        raise ValueError("Source baseline hash mismatch")
    splits, manifest = load_splits()
    import laya
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required")
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.reset_peak_memory_stats()
    started = time.monotonic()
    output.mkdir(parents=True, exist_ok=False)
    agent = laya.load(str(source), device="cuda")
    for row in splits["fit"] + splits["validation"] + splits["test"]:
        common.model_batch(agent, [row], [list(range(
            len(common.QUESTIONS[row["task"]]["crit"])))])
    baseline_validation = metrics(common.evaluate(agent, splits["validation"]))
    print(json.dumps({"stage": "baseline_validation", "metrics": baseline_validation}), flush=True)
    optimizer, parameters = common.configure(agent, args.encoder_lr, args.head_lr)
    history, best_epoch, best_score, stale = [], 0, (-1.0, -1.0, float("-inf")), 0
    for epoch in range(1, args.max_epochs + 1):
        loss = fit_epoch(agent, optimizer, parameters, splits["fit"], args.seed, epoch)
        validation = metrics(common.evaluate(agent, splits["validation"]))
        score = (validation["macro_all_orders_correct_rate"],
                 validation["macro_accuracy"], -validation["loss"])
        if score > best_score:
            best_epoch, best_score, stale = epoch, score, 0
        else:
            stale += 1
        record = {"epoch": epoch, "train_loss": loss, "validation": validation,
                  "selected_epoch_so_far": best_epoch}
        history.append(record)
        print(json.dumps({"stage": "selection_epoch", **record}), flush=True)
        if stale >= args.patience:
            break
    del optimizer, parameters, agent
    torch.cuda.empty_cache()

    final_agent = laya.load(str(source), device="cuda")
    optimizer, parameters = common.configure(final_agent, args.encoder_lr, args.head_lr)
    development = splits["fit"] + splits["validation"]
    refit_history = []
    for epoch in range(1, best_epoch + 1):
        loss = fit_epoch(final_agent, optimizer, parameters, development, args.seed, epoch)
        refit_history.append({"epoch": epoch, "train_loss": loss})
        print(json.dumps({"stage": "refit_epoch", **refit_history[-1]}), flush=True)
    checkpoint = output / "model"
    common.save_checkpoint(final_agent, checkpoint, source,
                           {"training": "joint-route-delivery-v2", "epochs": best_epoch,
                            "seed": args.seed, "rows": len(development),
                            "task_balance": "equal_total_weight",
                            "dataset_manifest_sha256": common.digest(DATA / "manifest.json")})
    del optimizer, parameters, final_agent
    torch.cuda.empty_cache()
    selected = laya.load(str(checkpoint), device="cuda")
    selected_test = common.evaluate(selected, splits["test"])
    baseline = laya.load(str(source), device="cuda")
    baseline_test = common.evaluate(baseline, splits["test"])
    report = {"status": "complete", "scope": "joint-route-delivery", "seed": args.seed,
              "source": str(source), "source_sha256": expected_hash,
              "dataset_manifest_sha256": common.digest(DATA / "manifest.json"),
              "split": manifest["outer_ratio"], "fit_rows": len(splits["fit"]),
              "validation_rows": len(splits["validation"]),
              "test_used_for_selection": False,
              "selection_criterion": "macro_all_orders_correct_then_macro_accuracy_then_loss",
              "objective": "uniform_cross_entropy_equal_total_task_weight",
              "hyperparameters": {"max_epochs": args.max_epochs, "patience": args.patience,
                                  "encoder_lr": args.encoder_lr, "head_lr": args.head_lr,
                                  "effective_batch": 16, "micro_batch": 4},
              "baseline_validation": baseline_validation, "selection_history": history,
              "selected_epochs": best_epoch, "refit_history": refit_history,
              "held_out_test": {"baseline": metrics(baseline_test),
                                "trained": metrics(selected_test)},
              "test_cases": selected_test["cases"], "checkpoint": str(checkpoint),
              "elapsed_seconds": round(time.monotonic() - started, 2),
              "peak_gpu_mib": round(torch.cuda.max_memory_allocated() / 2**20)}
    (output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "complete", "selected_epochs": best_epoch,
                      "held_out_test": report["held_out_test"],
                      "checkpoint": str(checkpoint)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
