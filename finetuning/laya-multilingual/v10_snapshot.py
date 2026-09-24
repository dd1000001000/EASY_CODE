"""Verify the immutable V10 dataset without requiring any older batches."""
from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

from v10_contract import QUESTIONS, read_rows, runtime_action

ROOT = Path(__file__).resolve().parent
DEFAULT_OUTPUT = ROOT / "data_runtime_v10"
PROTOCOL = "controller_inputs_teacher_v10"
SPLITS = ("train", "validation", "test")


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def verify(output: Path = DEFAULT_OUTPUT) -> dict:
    output = Path(output)
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("protocol") != PROTOCOL or set(manifest.get("splits", {})) != set(SPLITS):
        raise ValueError("Unexpected V10 snapshot protocol")
    if manifest.get("teacherCatalogSha256") != sha((ROOT / "teacher_cases_v10.py").read_bytes()):
        raise ValueError("Teacher catalog changed")
    if manifest.get("formatterSha256") != sha((ROOT / "materialize_approval_v10.mjs").read_bytes()):
        raise ValueError("Approval formatter changed")
    if manifest.get("teacherAuditSha256") != sha((output / "teacher_audit.jsonl").read_bytes()):
        raise ValueError("Teacher audit changed")
    all_ids: set[str] = set()
    all_inputs: set[tuple[str, str]] = set()
    pair_splits: dict[str, set[str]] = defaultdict(set)
    for split in SPLITS:
        entry = manifest["splits"][split]
        if entry.get("file") != f"{split}.jsonl":
            raise ValueError(f"Unexpected filename for {split}")
        raw = (output / entry["file"]).read_bytes()
        if sha(raw) != entry["sha256"]:
            raise ValueError(f"V10 {split} hash mismatch")
        rows = read_rows(output / entry["file"])
        if len(rows) != entry["rows"]:
            raise ValueError(f"V10 {split} row count mismatch")
        for row in rows:
            if set(row) != {"id", "task", "user", "answer"}:
                raise ValueError(f"Invalid V10 row: {row.get('id')}")
            case_id, task = row["id"], row["task"]
            if case_id in all_ids or task not in QUESTIONS or not isinstance(row["user"], str) or not row["user"].strip():
                raise ValueError(f"Duplicate/invalid V10 row: {case_id}")
            all_ids.add(case_id)
            key = (task, row["user"])
            if key in all_inputs:
                raise ValueError(f"Duplicate V10 input: {case_id}")
            all_inputs.add(key)
            decision = row["answer"].get("decision")
            if decision not in QUESTIONS[task]["crit"] or row["answer"].get("runtimeAction") != runtime_action(task, decision):
                raise ValueError(f"Invalid V10 label/action: {case_id}")
            if task == "approval":
                packet = json.loads(row["user"])
                required = {"userTask", "command", "preview", "description", "proposedPermission"}
                allowed = required | {"network", "source"}
                if not required <= set(packet) or set(packet) - allowed:
                    raise ValueError(f"Invalid approval packet: {case_id}")
                pair_splits[case_id[:-1]].add(split)
        actual = {task: {"rows": sum(row["task"] == task for row in rows),
                          "labels": dict(sorted(Counter(row["answer"]["decision"] for row in rows
                                                        if row["task"] == task).items()))}
                  for task in QUESTIONS}
        if actual != entry["tasks"]:
            raise ValueError(f"V10 {split} statistics mismatch")
    if any(len(locations) != 1 for locations in pair_splits.values()):
        raise ValueError("Approval pair crosses data splits")
    return manifest


def load_training_data(output: Path = DEFAULT_OUTPUT):
    output = Path(output)
    manifest = verify(output)
    return (read_rows(output / "train.jsonl"), read_rows(output / "validation.jsonl"), manifest,
            {"manifest.json": sha((output / "manifest.json").read_bytes()),
             **{f"{split}.jsonl": manifest["splits"][split]["sha256"] for split in SPLITS}})


if __name__ == "__main__":
    result = verify()
    print(json.dumps({split: result["splits"][split]["tasks"] for split in SPLITS},
                     ensure_ascii=False, indent=2))
