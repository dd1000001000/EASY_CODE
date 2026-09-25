"""Compare local Laya, GLM Coding Plan, and a confidence-gated cascade.

The API key is read from stdin, never from argv or a file. Run from any cwd.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import getpass
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib import error, request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SOURCE = ROOT / "finetuning/laya-joint-v2/data/test.jsonl"
QUESTIONS = json.loads((ROOT / "resources/laya-decision/questions.json").read_text(encoding="utf-8"))
CASES = HERE / "cases.jsonl"
RESULTS = HERE / "results.jsonl"
ROUTE_PILOT = HERE / "route-pilot.jsonl"
ENDPOINT = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
MODEL = "glm-5.3-flash"
THRESHOLD = 0.90


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def append_jsonl(path: Path, value: dict) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def prepare() -> list[dict]:
    """Freeze 100 per task from the group-disjoint held-out Luna-derived set."""
    if CASES.exists():
        rows = read_jsonl(CASES)
    else:
        source = read_jsonl(SOURCE)
        quotas = {"route": {"DIRECT": 34, "PLAN": 33, "CODE": 33},
                  "delivery": {"RELEASE": 50, "CHALLENGE": 50}}
        rows = []
        for task, labels in quotas.items():
            for label, count in labels.items():
                pool = [row for row in source if row["task"] == task
                        and row["answer"]["decision"] == label]
                pool.sort(key=lambda row: hashlib.sha256(
                    f"laya-benchmark-2026-09-25:{row['id']}".encode()).hexdigest())
                if len(pool) < count:
                    raise ValueError(f"Not enough held-out {task}/{label} examples")
                rows.extend({"id": row["id"], "task": task, "input": row["user"],
                             "expected": label} for row in pool[:count])
        rows.sort(key=lambda row: (row["task"], row["id"]))
        with CASES.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    if len(rows) != 200 or len({row["id"] for row in rows}) != 200 or \
            sum(row["task"] == "route" for row in rows) != 100 or \
            sum(row["task"] == "delivery" for row in rows) != 100:
        raise ValueError("The frozen benchmark must contain 100 unique cases per task")
    return rows


def local_results(rows: list[dict], python: str) -> dict[str, dict]:
    worker = ROOT / "resources/laya-decision/worker.py"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", USE_TF="0",
               HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    process = subprocess.Popen([python, str(worker)], cwd=ROOT, env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
    assert process.stdin and process.stdout
    try:
        ready = json.loads(process.stdout.readline())
        if ready.get("type") != "ready":
            raise RuntimeError(f"Laya worker did not start: {ready}")
        output = {}
        for index, row in enumerate(rows, 1):
            process.stdin.write(json.dumps({"id": row["id"], "task": row["task"],
                                            "input": row["input"]}, ensure_ascii=False) + "\n")
            process.stdin.flush()
            value = json.loads(process.stdout.readline())
            if value.get("type") != "result" or value.get("id") != row["id"]:
                raise RuntimeError(f"Laya inference failed for {row['id']}: {value}")
            output[row["id"]] = {"decision": value["decision"], "scores": value["scores"],
                                  "input_tokens": value["inputTokens"],
                                  "truncated": value["truncated"], "device": ready["device"],
                                  "weight_sha256": ready["modelSha256"]}
            if index % 25 == 0:
                print(f"Laya: {index}/{len(rows)}", flush=True)
        return output
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


def parse_choice(content: object, task: str) -> str | None:
    if not isinstance(content, str):
        return None
    text = content.strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            text = str(parsed.get("decision", "")).strip()
    except json.JSONDecodeError:
        pass
    text = text.strip("` \t\r\n\"'").upper()
    labels = set(QUESTIONS[task]["crit"])
    return text if text in labels else None


def glm_one(row: dict, key: str, *, include_content: bool = False) -> dict:
    question = QUESTIONS[row["task"]]
    criteria = "\n".join(f"{name}: {description}" for name, description in question["crit"].items())
    system = (f"{question['ins']}\n\n{criteria}\n\n"
              "Classify the user input. Return ONLY one uppercase label from the list above. "
              "No reasoning, punctuation, JSON, or explanation.")
    user_content = row["input"]
    if row["task"] == "route":
        user_content = ("CLASSIFICATION TASK — do not answer or perform the request below. "
                        "Choose the EASY CODE mode for that request. Return exactly one of "
                        "DIRECT, PLAN, CODE.\n\n<request_to_classify>\n"
                        + row["input"] + "\n</request_to_classify>")
    body = json.dumps({"model": MODEL, "stream": False, "messages": [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]}, ensure_ascii=False).encode("utf-8")
    last_error = ""
    attempts = 0
    for attempt in range(3):
        attempts += 1
        req = request.Request(ENDPOINT, data=body, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with request.urlopen(req, timeout=180) as response:
                data = json.load(response)
            message = data["choices"][0]["message"]
            usage = data.get("usage") or {}
            result = {"decision": parse_choice(message.get("content"), row["task"]),
                    "finish_reason": data["choices"][0].get("finish_reason"),
                    "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                    "completion_tokens": int(usage.get("completion_tokens") or 0),
                    "total_tokens": int(usage.get("total_tokens") or 0),
                    "usage_reported": bool(usage), "attempts": attempt + 1}
            if include_content:
                result["content"] = message.get("content")
            return result
        except error.HTTPError as exc:
            last_error = f"HTTP {exc.code}"
            if exc.code not in (408, 429, 500, 502, 503, 504):
                break
        except (error.URLError, TimeoutError, ValueError, KeyError) as exc:
            last_error = type(exc).__name__
        time.sleep(2 ** attempt)
    return {"decision": None, "error": last_error, "attempts": attempts,
            "usage_reported": False, "prompt_tokens": 0, "completion_tokens": 0,
            "total_tokens": 0}


def run(rows: list[dict], python: str, key: str) -> None:
    prior = {row["id"]: row for row in read_jsonl(RESULTS)} if RESULTS.exists() else {}
    if len(prior) == len(rows):
        print("All 200 cases already recorded; rerun report only.")
        return
    missing = [row for row in rows if row["id"] not in prior]
    local = local_results(missing, python)
    # A GLM-only result is reused for the cascade fallback: no second billed
    # API request is needed to estimate the identical per-case decision.
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(glm_one, row, key): row for row in missing}
        for index, future in enumerate(as_completed(futures), 1):
            row = futures[future]
            append_jsonl(RESULTS, {**row, "laya": local[row["id"]], "glm": future.result()})
            if index % 10 == 0 or index == len(missing):
                print(f"GLM: {index}/{len(missing)} new cases recorded", flush=True)


def archive_and_reset_route() -> None:
    if ROUTE_PILOT.exists():
        return
    if not RESULTS.exists():
        raise ValueError("No pilot results to archive")
    prior = read_jsonl(RESULTS)
    route = [row for row in prior if row["task"] == "route"]
    delivery = [row for row in prior if row["task"] == "delivery"]
    if len(route) != 100 or len(delivery) != 100:
        raise ValueError("Need complete pilot results before route rerun")
    with ROUTE_PILOT.open("w", encoding="utf-8") as handle:
        for row in route:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    with RESULTS.open("w", encoding="utf-8") as handle:
        for row in delivery:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("Archived the first route prompt run; retaining delivery results.", flush=True)


def score(rows: list[dict], task: str, method: str) -> dict:
    subset = [row for row in rows if row["task"] == task]
    chosen = []
    fallbacks = 0
    for row in subset:
        local = row["laya"]
        confidence = float(local["scores"][local["decision"]])
        fallback = confidence < THRESHOLD
        if method == "Laya":
            decision = local["decision"]
        elif method == "GLM":
            decision = row["glm"]["decision"]
        else:
            fallbacks += fallback
            decision = row["glm"]["decision"] if fallback else local["decision"]
        chosen.append(decision)
    correct = sum(choice == row["expected"] for row, choice in zip(subset, chosen))
    labels = list(QUESTIONS[task]["crit"])
    matrix = {actual: {pred: sum(row["expected"] == actual and choice == pred
                                for row, choice in zip(subset, chosen)) for pred in labels}
              for actual in labels}
    invalid = sum(choice is None for choice in chosen)
    return {"count": len(subset), "correct": correct, "accuracy": correct / len(subset),
            "fallbacks": fallbacks, "invalid": invalid, "matrix": matrix}


def report() -> None:
    from presentation import render_report

    rows = read_jsonl(RESULTS)
    if len(rows) != 200 or len({row["id"] for row in rows}) != 200:
        raise ValueError("Need all 200 unique results before writing the report")
    if any(not row["glm"]["usage_reported"] for row in rows):
        raise ValueError("Cannot chart complete cloud costs with missing token usage")
    metrics = {task: {method: score(rows, task, method)
                      for method in ("Laya", "GLM", "Cascade")}
               for task in ("route", "delivery")}
    render_report(HERE, rows, metrics, THRESHOLD)
    print("Report ready:", HERE / "README.md")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--prepare", action="store_true")
    group.add_argument("--run", action="store_true")
    group.add_argument("--report", action="store_true")
    group.add_argument("--probe-id")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--rerun-route", action="store_true")
    args = parser.parse_args()
    if args.prepare:
        print("Frozen cases:", len(prepare()))
    elif args.run:
        if args.rerun_route:
            archive_and_reset_route()
        rows = prepare()
        if RESULTS.exists() and len({row["id"] for row in read_jsonl(RESULTS)}) == len(rows):
            print("All 200 cases already recorded; use --report to regenerate charts.")
            raise SystemExit(0)
        key = getpass.getpass("Temporary GLM key (not echoed or stored): ").strip()
        if not key:
            raise SystemExit("Missing temporary API key")
        run(rows, args.python, key)
    elif args.probe_id:
        row = next((item for item in prepare() if item["id"] == args.probe_id), None)
        if not row:
            raise SystemExit("Unknown case ID")
        key = getpass.getpass("Temporary GLM key (not echoed or stored): ").strip()
        if not key:
            raise SystemExit("Missing temporary API key")
        print(json.dumps(glm_one(row, key, include_content=True), ensure_ascii=False, indent=2))
    else:
        report()
