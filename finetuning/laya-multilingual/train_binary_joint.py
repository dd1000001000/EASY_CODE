"""Fine-tune the frozen V10 route, command-review, and delivery dataset.

Approval contrast pairs stay intact in each shuffled epoch. Every example gets
an independently shuffled answer order. An optional pairwise loss trains the
safe command's AUTO_ALLOW score above the risky command's score.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

from v10_contract import QUESTIONS, case_label, case_question, counts
from v10_snapshot import DEFAULT_OUTPUT, PROTOCOL, load_training_data
from v10_training_support import DEFAULT_MODEL, prepare_output, save_checkpoint, training_parameters


def encode_case(tokenizer, config: dict, row: dict, order: list[int]) -> dict:
    from laya.common import build_sequence

    question = case_question(row)
    if sorted(order) != list(range(len(question["crit"]))):
        raise ValueError(f"{row['id']}: invalid answer permutation")
    ids, markers = build_sequence(tokenizer, row["user"], question,
                                  max_len=config["max_len"],
                                  head_max_len=config["head_max_len"], option_order=order)
    full_ids, _ = build_sequence(tokenizer, row["user"], question,
                                 max_len=max(8192, config["max_len"] * 8),
                                 head_max_len=config["head_max_len"], option_order=order)
    if len(markers) != len(order) or len(full_ids) > config["max_len"]:
        raise ValueError(f"{row['id']}: model input exceeds its context window")
    return {"ids": ids, "markers": markers, "qtype": 0,
            "label": order.index(case_label(row))}


def model_batch(agent, rows: list[dict], orders: list[list[int]]):
    from laya.common import collate_items

    items = [encode_case(agent.tok, agent.cfg, row, order)
             for row, order in zip(rows, orders, strict=True)]
    batch = collate_items([[item] for item in items], agent.tok.pad_token_id)
    return {key: value.to(agent.device) for key, value in batch.items()
            if key in {"input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype", "label"}}


def forward_logits(model, batch):
    logits, _ = model(**{key: batch[key] for key in
                         ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")})
    return logits.float()


def training_units(rows: list[dict]) -> list[list[dict]]:
    pairs = defaultdict(list)
    units = []
    for row in rows:
        if row["task"] == "approval":
            pairs[row["id"][:-1]].append(row)
        else:
            units.append([row])
    for pair_id, pair in pairs.items():
        if len(pair) != 2 or {row["id"][-1] for row in pair} != {"a", "b"}:
            raise ValueError(f"Incomplete approval pair: {pair_id}")
        units.append(pair)
    return units


def repeated_training_units(rows: list[dict], approval_repeats: int) -> list[list[dict]]:
    if approval_repeats < 1:
        raise ValueError("approval_repeats must be positive")
    units = training_units(rows)
    approval_units = [unit for unit in units if unit[0]["task"] == "approval"]
    return units + approval_units * (approval_repeats - 1)


def shuffled_windows(units: list[list[dict]], rng: random.Random, size: int):
    ordered = list(units)
    rng.shuffle(ordered)
    window = []
    sample_count = 0
    for unit in ordered:
        if sample_count + len(unit) > size and window:
            yield window
            window = []
            sample_count = 0
        members = list(unit)
        rng.shuffle(members)
        window.append(members)
        sample_count += len(members)
    if window:
        yield window


def unit_loss(logits, batch, rows: list[dict], orders: list[list[int]],
              pair_weight: float, pair_margin: float, review_weight: float):
    import torch
    import torch.nn.functional as F

    losses = F.cross_entropy(logits, batch["label"], reduction="none")
    weights = torch.tensor([review_weight if row["task"] == "approval" and
                            row["answer"]["decision"] == "NEED_REVIEW" else 1.0
                            for row in rows], device=logits.device)
    result = (losses * weights).mean()
    contrast = len(rows) == 2 and rows[0]["task"] == "approval" and {
        row["answer"]["decision"] for row in rows
    } == {"AUTO_ALLOW", "NEED_REVIEW"}
    if contrast and pair_weight > 0:
        labels = list(QUESTIONS["approval"]["crit"])
        auto_index, review_index = labels.index("AUTO_ALLOW"), labels.index("NEED_REVIEW")
        gaps = [logits[i, order.index(auto_index)] - logits[i, order.index(review_index)]
                for i, order in enumerate(orders)]
        safe_index = next(i for i, row in enumerate(rows)
                          if row["answer"]["decision"] == "AUTO_ALLOW")
        risky_index = 1 - safe_index
        # Positive margin pushes the safe command's allow-vs-review score above
        # the risky command's score, independent of answer option positions.
        result = result + pair_weight * F.softplus(pair_margin -
                                                    (gaps[safe_index] - gaps[risky_index]))
    return result, contrast


def validate(agent, rows: list[dict], batch_size: int) -> dict:
    import torch
    import torch.nn.functional as F

    agent.model.eval()
    work = [(row, list(order)) for row in rows for order in
            itertools.permutations(range(len(case_question(row)["crit"]))) ]
    predictions = defaultdict(list)
    loss_total = 0.0
    with torch.inference_mode():
        for start in range(0, len(work), batch_size):
            part = work[start:start + batch_size]
            batch = model_batch(agent, [row for row, _ in part], [order for _, order in part])
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = forward_logits(agent.model, batch)
            loss_total += F.cross_entropy(logits, batch["label"], reduction="sum").item()
            for (row, order), choice in zip(part, logits.argmax(-1).tolist(), strict=True):
                predicted = list(case_question(row)["crit"])[order[choice]]
                predictions[row["id"]].append(predicted)

    groups = defaultdict(list)
    for row in rows:
        groups[row["task"]].append(row)
    by_task = {}
    for task, task_rows in groups.items():
        total = sum(len(predictions[row["id"]]) for row in task_rows)
        correct = sum(sum(answer == row["answer"]["decision"]
                          for answer in predictions[row["id"]]) for row in task_rows)
        by_task[task] = {"cases": len(task_rows), "correct_orders": correct,
                         "total_orders": total, "accuracy_all_orders": correct / total,
                         "changed_answer_cases": sum(len(set(predictions[row["id"]])) > 1
                                                     for row in task_rows)}
    approval = groups["approval"]
    risky = [row for row in approval if row["answer"]["decision"] == "NEED_REVIEW"]
    safe = [row for row in approval if row["answer"]["decision"] == "AUTO_ALLOW"]
    false_auto_any = sum("AUTO_ALLOW" in predictions[row["id"]] for row in risky)
    safe_auto_all = sum(all(answer == "AUTO_ALLOW" for answer in predictions[row["id"]])
                        for row in safe)
    approval_pairs = defaultdict(list)
    for row in approval:
        approval_pairs[row["id"][:-1]].append(row)
    contrasting = [pair for pair in approval_pairs.values()
                   if len(pair) == 2 and {r["answer"]["decision"] for r in pair} ==
                   {"AUTO_ALLOW", "NEED_REVIEW"}]
    pairs_correct_all_orders = sum(all(all(answer == row["answer"]["decision"]
                                           for answer in predictions[row["id"]]) for row in pair)
                                   for pair in contrasting)
    route_accuracy = by_task["route"]["accuracy_all_orders"]
    delivery_accuracy = by_task["delivery"]["accuracy_all_orders"]
    safe_recall = safe_auto_all / len(safe)
    unsafe_rate = false_auto_any / len(risky)
    return {"loss": loss_total / len(work), "by_task": by_task,
            "approval": {"safe_cases": len(safe), "risky_cases": len(risky),
                         "safe_auto_in_both_orders": safe_auto_all,
                         "unsafe_auto_in_any_order": false_auto_any,
                         "contrasting_pairs": len(contrasting),
                         "contrasting_pairs_correct_in_all_orders": pairs_correct_all_orders},
            "selection_score": route_accuracy + delivery_accuracy + safe_recall - 3.0 * unsafe_rate}


def train(args, agent, train_rows: list[dict], validation_rows: list[dict], source_hashes: dict):
    import torch

    model = agent.model
    model.head_checkpointing = True
    if hasattr(model.encoder, "gradient_checkpointing_enable"):
        model.encoder.gradient_checkpointing_enable()
    parameters = training_parameters(model, args.encoder_learning_rate, args.head_learning_rate)
    optimizer = torch.optim.AdamW(parameters, weight_decay=args.weight_decay)
    units = repeated_training_units(train_rows, args.approval_repeats)
    effective_batch = args.grad_accum_steps * args.micro_batch_size
    epoch_examples = sum(len(unit) for unit in units)
    planned = args.max_updates or args.epochs * math.ceil(epoch_examples / effective_batch)
    warmup = max(1, round(planned * args.warmup_ratio))

    def schedule(step):
        return ((step + 1) / warmup if step < warmup else
                max(0.1, (planned - step) / max(1, planned - warmup)))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, schedule)
    rng = random.Random(args.seed)
    best_key = None
    best_epoch = 0
    stale_epochs = 0
    updates = 0
    history = []
    for epoch in range(1, args.epochs + 1):
        model.train()
        seen = 0
        epoch_loss = 0.0
        contrast_pairs_seen = 0
        label_positions = defaultdict(Counter)
        sequence = []
        for window in shuffled_windows(units, rng, effective_batch):
            optimizer.zero_grad(set_to_none=True)
            window_size = sum(len(unit) for unit in window)
            for unit in window:
                orders = []
                for row in unit:
                    order = list(range(len(case_question(row)["crit"])))
                    rng.shuffle(order)
                    orders.append(order)
                    label_positions[row["task"]][order.index(case_label(row))] += 1
                    sequence.append(row["id"])
                batch = model_batch(agent, unit, orders)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    logits = forward_logits(model, batch)
                    loss, contrast = unit_loss(logits, batch, unit, orders,
                                               args.pair_weight, args.pair_margin,
                                               args.review_weight)
                if not torch.isfinite(loss):
                    raise RuntimeError(f"Non-finite loss at update {updates + 1}")
                (loss * len(unit) / window_size).backward()
                epoch_loss += loss.item() * len(unit)
                seen += len(unit)
                contrast_pairs_seen += int(contrast)
            if updates == 0 and (not any(p.grad is not None for p in model.encoder.parameters()) or
                                 not any(p.grad is not None for p in model.scorer.parameters())):
                raise RuntimeError("Expected encoder and scoring-head gradients")
            torch.nn.utils.clip_grad_norm_([p for group in parameters for p in group["params"]],
                                           args.max_grad_norm)
            optimizer.step()
            scheduler.step()
            updates += 1
            if args.smoke or updates % 10 == 0:
                print(json.dumps({"epoch": epoch, "update": updates,
                                  "train_loss_so_far": round(epoch_loss / seen, 5),
                                  "gpu_peak_mib": round(torch.cuda.max_memory_allocated() / 2**20)}),
                      flush=True)
            if args.max_updates and updates >= args.max_updates:
                break
        metrics = validate(agent, validation_rows, args.eval_batch_size)
        record = {"epoch": epoch, "updates": updates, "train_loss": epoch_loss / seen,
                  "contrast_pairs_seen": contrast_pairs_seen,
                  "order_digest": hashlib.sha256("|".join(sequence).encode()).hexdigest()[:12],
                  "answer_positions": {task: dict(sorted(count.items()))
                                       for task, count in label_positions.items()},
                  "validation": metrics}
        history.append(record)
        print(json.dumps(record, ensure_ascii=False), flush=True)
        if args.selection_policy == "safety_first":
            # Primary objective is fewer false automatic approvals on the
            # fixed validation set; safe recall and other tasks break ties.
            key = (-metrics["approval"]["unsafe_auto_in_any_order"],
                   metrics["approval"]["safe_auto_in_both_orders"],
                   metrics["by_task"]["route"]["accuracy_all_orders"] +
                   metrics["by_task"]["delivery"]["accuracy_all_orders"])
        else:
            key = (metrics["selection_score"],)
        if best_key is None or key > best_key:
            best_key = key
            best_epoch = epoch
            stale_epochs = 0
            save_checkpoint(agent, args.output, {
                "method": "joint_supervised_binary_approval",
                "pair_ranking_enabled": args.pair_weight > 0,
                "source_model": str(args.model), "source_sha256": source_hashes,
                "selection_rule": ("validation: minimize risky auto-allow in either order, then maximize stable safe approval, then route+delivery accuracy"
                    if args.selection_policy == "safety_first" else
                    "route order accuracy + delivery order accuracy + stable safe approval recall - 3 * risky auto approval rate in either order"),
                "best_epoch": best_epoch, "best_validation": metrics,
                "config": {key: str(value) if isinstance(value, Path) else value
                           for key, value in vars(args).items()}, "history": history,
                "examples_per_epoch_with_repeats": epoch_examples,
                "test_examples_used_for_selection": False,
            })
        else:
            stale_epochs += 1
        if (args.max_updates and updates >= args.max_updates) or stale_epochs >= args.patience:
            break
    del optimizer, scheduler
    torch.cuda.empty_cache()
    reloaded = __import__("laya").load(str(args.output), device="cuda")
    probe = validation_rows[0]
    prediction = reloaded.predict(probe["user"], {probe["task"]: {
        "type": "choice", "instructions": case_question(probe)["ins"],
        "criteria": case_question(probe)["crit"]}})
    return {"status": "checkpoint_reloaded", "output": str(args.output),
            "best_epoch": best_epoch, "updates": updates,
            "probe_id": probe["id"],
            "probe_prediction": prediction["answers"][probe["task"]]["choice"],
            "gpu_peak_mib": round(torch.cuda.max_memory_allocated() / 2**20)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--max-updates", type=int, default=0)
    parser.add_argument("--micro-batch-size", type=int, default=1)
    parser.add_argument("--grad-accum-steps", type=int, default=16)
    parser.add_argument("--eval-batch-size", type=int, default=12)
    parser.add_argument("--encoder-learning-rate", type=float, default=1e-5)
    parser.add_argument("--head-learning-rate", type=float, default=5e-5)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--max-grad-norm", type=float, default=1.0)
    parser.add_argument("--warmup-ratio", type=float, default=0.1)
    parser.add_argument("--patience", type=int, default=2)
    parser.add_argument("--approval-repeats", type=int, default=1)
    parser.add_argument("--pair-weight", type=float, default=0.0)
    parser.add_argument("--pair-margin", type=float, default=0.5)
    parser.add_argument("--review-weight", type=float, default=1.5)
    parser.add_argument("--selection-policy", choices=("composite", "safety_first"), default="composite")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if (args.epochs < 1 or args.max_updates < 0 or args.micro_batch_size < 1 or
        args.grad_accum_steps < 2 or args.eval_batch_size < 1 or args.patience < 1 or
        args.encoder_learning_rate <= 0 or args.head_learning_rate <= 0 or
        args.pair_weight < 0 or args.pair_margin < 0 or args.review_weight < 1 or
        args.approval_repeats < 1 or
        args.weight_decay < 0 or args.max_grad_norm <= 0 or not 0 <= args.warmup_ratio < 1):
        parser.error("Invalid training hyperparameter")
    if args.smoke:
        args.max_updates = 2
        args.epochs = 1
    if args.output.exists():
        raise FileExistsError(f"Output already exists: {args.output}")
    protocol = json.loads((args.data_root / "manifest.json").read_text(encoding="utf-8"))["protocol"]
    if protocol != PROTOCOL:
        raise ValueError(f"Only frozen V10 data is supported: {protocol}")
    train_rows, validation_rows, manifest, hashes = load_training_data(args.data_root)
    evaluation_note = manifest["testNote"]
    print(json.dumps({"train": counts(train_rows), "validation": counts(validation_rows),
                      "evaluation_note": evaluation_note,
                      "approval_repeats": args.approval_repeats,
                      "source_sha256": hashes},
                     ensure_ascii=False), flush=True)
    import laya
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU is required")
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    agent = laya.load(str(args.model), device="cuda")
    for row in train_rows + validation_rows:
        encode_case(agent.tok, agent.cfg, row, list(range(len(case_question(row)["crit"]))))
    prepare_output(args.model, args.output)
    print(json.dumps(train(args, agent, train_rows, validation_rows, hashes),
                     ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
