"""The frozen V10 test split, stored alongside this benchmark."""

from __future__ import annotations

import hashlib
from pathlib import Path

from v10_contract import QUESTIONS, read_rows


ROOT = Path(__file__).resolve().parent
TEST_FILE = ROOT / "data" / "test.jsonl"
TEST_SHA256 = "f73203b16c6fa6da79e41d008dd22b27c4b4573913ba9fcf43144c3124d991d1"


def verified_rows() -> list[dict]:
    if hashlib.sha256(TEST_FILE.read_bytes()).hexdigest() != TEST_SHA256:
        raise ValueError("The frozen benchmark test set has changed")
    rows = read_rows(TEST_FILE)
    if len(rows) != 126 or len({row["id"] for row in rows}) != len(rows):
        raise ValueError("The frozen benchmark test set is incomplete or duplicated")
    for row in rows:
        if row["task"] not in QUESTIONS or row["answer"]["decision"] not in QUESTIONS[row["task"]]["crit"]:
            raise ValueError(f"Invalid benchmark case: {row['id']}")
    return rows
