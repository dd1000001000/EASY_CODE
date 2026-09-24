"""Score the folder-local Laya weights on every option order of the frozen test."""

from __future__ import annotations

import itertools
import math
import random
import time
from datetime import datetime, timezone
from pathlib import Path

from benchmark_data import TEST_SHA256, verified_rows
from v10_contract import QUESTIONS


def encode_case(tokenizer, config: dict, row: dict, order: list[int]) -> dict:
    from laya.common import build_sequence

    question = QUESTIONS[row["task"]]
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
    labels = list(question["crit"])
    return {"ids": ids, "markers": markers, "qtype": 0,
            "label": order.index(labels.index(row["answer"]["decision"]))}


def evaluate(model_path: Path, batch_size: int = 16, seed: int = 271828) -> dict:
    import laya
    import torch
    from laya.common import collate_items

    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    rows = verified_rows()
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
        permutations = list(itertools.permutations(range(len(QUESTIONS[row["task"]]["crit"]))))
        random.Random(f"{seed}:{row['id']}").shuffle(permutations)
        for order in permutations:
            work.append((row, list(order), encode_case(agent.tok, agent.cfg, row, list(order))))
    with torch.inference_mode():
        for start in range(0, len(work), batch_size):
            part = work[start:start + batch_size]
            batch = collate_items([[item] for _, _, item in part], agent.tok.pad_token_id)
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
                records[row["id"]]["orders"].append({
                    "order": [labels[i] for i in order],
                    "predicted": max(semantic, key=semantic.get),
                    "probabilities": semantic,
                })
    return {"evaluated_at_utc": datetime.now(timezone.utc).isoformat(),
            "model": str(model_path), "split": "test", "seed": seed,
            "source_sha256": {"test.jsonl": TEST_SHA256},
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "cases": list(records.values())}
