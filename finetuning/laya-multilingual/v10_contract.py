"""The frozen V10 three-task choice contract; no earlier dataset dependency."""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path


QUESTIONS = {
    "route": {
        "t": "choice",
        "ins": "Choose the EASY CODE work mode for the current request. A direct answer may use only the request and bounded prior conversation; needing live workspace, capability, web, or other tool inspection means CODE even if the user asks only for an explanation. Decide by the requested outcome, not by quoted words.",
        "crit": {
            "DIRECT": "Answer completely from supplied information without tools, current-state inspection, implementation, or a reviewable plan.",
            "PLAN": "Provide a reviewable design or implementation plan before making changes, or first resolve a consequential design choice.",
            "CODE": "Inspect current state, use tools or external information, implement, fix, create, edit, or verify; choose CODE over PLAN when both are plausible unless review first is materially necessary.",
        },
    },
    "approval": {
        "t": "choice",
        "ins": "Review the complete Runtime approval packet against the user's task. Evaluate only whether this exact command is clearly task-related and can execute once automatically, considering its full command, working directory, scope, and network effects. If risk or authority is unclear, send it to the independent approval agent for review.",
        "crit": {
            "AUTO_ALLOW": "The exact command is clearly requested or necessary for the user's task, and its effects are bounded and appropriate for this invocation. Allow this invocation once.",
            "NEED_REVIEW": "The exact command is unrelated, destructive, exposes credentials or data, has unclear authority or effects, or otherwise needs independent approval-agent review before execution.",
        },
    },
    "delivery": {
        "t": "choice",
        "ins": "Compare every requested outcome with the main agent's own work summary. Ignore external artifacts, tests, tool output, and third-party evidence; a claim in the summary that tests passed is not independent proof. Do not infer that an unmentioned requirement was completed.",
        "crit": {
            "RELEASE": "The main agent's own summary explicitly covers each requested outcome with no stated omission or contradiction; allow delivery without claiming independent verification.",
            "CHALLENGE": "At least one requested outcome is missing from the summary, admitted unfinished, or contradicted; send it back for one correction.",
        },
    },
}


def case_question(row: dict) -> dict:
    return QUESTIONS[row["task"]]


def case_label(row: dict) -> int:
    return list(case_question(row)["crit"]).index(row["answer"]["decision"])


def counts(rows: list[dict]) -> dict[str, int]:
    return dict(sorted(Counter(f"{row['task']}/{row['answer']['decision']}" for row in rows).items()))


def runtime_action(task: str, decision: str) -> dict:
    if task == "route":
        if decision == "DIRECT":
            return {"tool": "respond_directly", "content": "not_supervised", "threadTitle": "not_supervised"}
        if decision in {"PLAN", "CODE"}:
            return {"tool": "select_mode", "mode": decision.lower(), "reason": "not_supervised", "threadTitle": "not_supervised"}
    if task == "approval" and decision in {"AUTO_ALLOW", "NEED_REVIEW"}:
        return {"decision": "allow_once" if decision == "AUTO_ALLOW" else "reject", "reason": "not_supervised"}
    if task == "delivery" and decision in {"RELEASE", "CHALLENGE"}:
        return {"protocol": "future_pre_delivery_gate_v1", "decision": decision.lower()}
    raise ValueError(f"Unknown V10 action: {task}/{decision}")


def read_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
