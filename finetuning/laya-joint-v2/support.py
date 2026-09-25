"""Self-contained Laya choice batching, evaluation, and checkpoint helpers."""
from __future__ import annotations

import hashlib
import itertools
import json
import os
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
SOURCE = PROJECT / "model-weights/laya-multilingual/upstream-base"

QUESTIONS = json.loads((PROJECT / "resources/laya-decision/questions.json").read_text(encoding="utf-8"))


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows_from(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def model_batch(agent, rows: list[dict], orders: list[list[int]]):
    import torch
    from laya.common import build_sequence, collate_items

    items = []
    for row, order in zip(rows, orders, strict=True):
        question = QUESTIONS[row["task"]]
        if sorted(order) != list(range(len(question["crit"]))):
            raise ValueError(f"Invalid answer order: {row['id']}")
        tokens, markers = build_sequence(
            agent.tok, row["user"], question,
            max_len=agent.cfg["max_len"], head_max_len=agent.cfg["head_max_len"],
            option_order=order)
        if len(markers) != len(order):
            raise ValueError(f"Truncated choice markers: {row['id']}")
        label = list(question["crit"]).index(row["answer"]["decision"])
        items.append({"ids": tokens, "markers": markers, "qtype": 0,
                      "label": order.index(label)})
    packed = collate_items([[item] for item in items], agent.tok.pad_token_id)
    result = {key: value.to(agent.device) for key, value in packed.items()
              if key in {"input_ids", "attention_mask", "marker_pos", "marker_mask",
                         "qtype", "label"}}
    result["task_idx"] = torch.tensor(
        [int(row["task"] == "delivery") for row in rows], device=agent.device)
    return result


def logits_for(model, batch):
    keys = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
    if getattr(model, "uses_task_idx", False):
        keys.append("task_idx")
    logits, _ = model(**{key: batch[key] for key in keys})
    return logits.float()


def evaluate(agent, rows: list[dict], batch_size: int = 12) -> dict:
    import torch
    import torch.nn.functional as F

    agent.model.eval()
    work = [(row, list(order)) for row in rows for order in
            itertools.permutations(range(len(QUESTIONS[row["task"]]["crit"]))) ]
    cases = {}
    loss_sum = 0.0
    with torch.inference_mode():
        for start in range(0, len(work), batch_size):
            portion = work[start:start + batch_size]
            batch = model_batch(agent, [row for row, _ in portion],
                                [order for _, order in portion])
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = logits_for(agent.model, batch)
            loss_sum += F.cross_entropy(logits, batch["label"], reduction="sum").item()
            for (row, order), scores in zip(portion, logits, strict=True):
                labels = list(QUESTIONS[row["task"]]["crit"])
                valid_scores = scores[:len(order)]
                prediction = labels[order[int(valid_scores.argmax())]]
                entry = cases.setdefault(row["id"], {
                    "id": row["id"], "task": row["task"],
                    "expected": row["answer"]["decision"], "orders": []})
                entry["orders"].append({
                    "order": [labels[index] for index in order],
                    "predicted": prediction,
                    "probabilities": {labels[order[index]]: float(probability)
                                      for index, probability in
                                      enumerate(valid_scores.softmax(-1))}})
    by_task = {}
    for task in QUESTIONS:
        subset = [case for case in cases.values() if case["task"] == task]
        if not subset:
            continue
        total = sum(len(case["orders"]) for case in subset)
        correct = sum(order["predicted"] == case["expected"]
                      for case in subset for order in case["orders"])
        by_task[task] = {
            "cases": len(subset), "correct_orders": correct,
            "total_orders": total, "accuracy": correct / total,
            "all_orders_correct": sum(all(order["predicted"] == case["expected"]
                                      for order in case["orders"]) for case in subset),
            "inconsistent_cases": sum(len({order["predicted"] for order in case["orders"]}) > 1
                                      for case in subset),
        }
    return {"loss": loss_sum / len(work), "by_task": by_task,
            "cases": list(cases.values())}


def configure(agent, encoder_lr: float, head_lr: float):
    import torch

    model = agent.model
    model.head_checkpointing = True
    model.encoder.gradient_checkpointing_enable()
    for parameter in model.act_head.parameters():
        parameter.requires_grad_(False)
    encoder = list(model.encoder.parameters())
    choice = [parameter for name, parameter in model.named_parameters()
              if not name.startswith("encoder.") and parameter.requires_grad]
    optimizer = torch.optim.AdamW([
        {"params": encoder, "lr": encoder_lr},
        {"params": choice, "lr": head_lr}], weight_decay=.01)
    return optimizer, encoder + choice


def save_checkpoint(agent, folder: Path, source: Path, metadata: dict) -> None:
    from safetensors.torch import save_file

    folder.mkdir(parents=True, exist_ok=True)
    for name in ("encoder", "tokenizer"):
        if not (folder / name).exists():
            shutil.copytree(source / name, folder / name)
    shutil.copy2(source / "rl_agent_config.json", folder / "rl_agent_config.json")
    pending = folder / "model.safetensors.pending"
    save_file({name: weight.detach().contiguous().cpu()
               for name, weight in agent.model.state_dict().items()}, pending)
    os.replace(pending, folder / "model.safetensors")
    (folder / "training_metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
