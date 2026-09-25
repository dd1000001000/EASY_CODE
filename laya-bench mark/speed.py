"""Measure local Laya and GLM latency on the frozen 200-case benchmark.

The GLM key is read with getpass and held in memory only. Successful case
timings are checkpointed by ID so an interrupted run can resume safely.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import getpass
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

import benchmark

HERE = Path(__file__).resolve().parent
TIMINGS = HERE / "speed-results.jsonl"
SUMMARY = HERE / "speed-summary.json"
WORKER = benchmark.ROOT / "resources/laya-decision/worker.py"


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    return ordered[lower] + (ordered[min(lower + 1, len(ordered) - 1)] - ordered[lower]) * (position - lower)


def stats(values: list[float]) -> dict:
    return {"count": len(values), "mean_ms": round(statistics.mean(values), 2),
            "median_ms": round(statistics.median(values), 2),
            "p95_ms": round(percentile(values, .95), 2)}


def local_timings(rows: list[dict], python: str) -> tuple[dict, float, str]:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", USE_TF="0",
               HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    started = time.perf_counter()
    process = subprocess.Popen([python, str(WORKER)], cwd=benchmark.ROOT, env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
    assert process.stdin and process.stdout
    try:
        ready = json.loads(process.stdout.readline())
        if ready.get("type") != "ready":
            raise RuntimeError(f"Laya worker did not start: {ready}")
        cold_ms = (time.perf_counter() - started) * 1000
        timings = {}
        for index, row in enumerate(rows, 1):
            began = time.perf_counter()
            process.stdin.write(json.dumps({"id": row["id"], "task": row["task"],
                                            "input": row["input"]}, ensure_ascii=False) + "\n")
            process.stdin.flush()
            value = json.loads(process.stdout.readline())
            elapsed_ms = (time.perf_counter() - began) * 1000
            if value.get("type") != "result" or value.get("id") != row["id"]:
                raise RuntimeError(f"Laya inference failed for {row['id']}: {value}")
            timings[row["id"]] = {"ms": round(elapsed_ms, 2),
                                  "input_tokens": value["inputTokens"]}
            if index % 25 == 0:
                print(f"Laya timing: {index}/{len(rows)}", flush=True)
        return timings, round(cold_ms, 2), ready["device"]
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


def glm_timing(row: dict, key: str) -> dict:
    began = time.perf_counter()
    try:
        result = benchmark.glm_one(row, key)
    except Exception as exc:
        return {"ms": round((time.perf_counter() - began) * 1000, 2),
                "attempts": 0, "total_tokens": 0,
                "valid_decision": False, "api_error": type(exc).__name__}
    elapsed_ms = (time.perf_counter() - began) * 1000
    return {"ms": round(elapsed_ms, 2), "attempts": result["attempts"],
            "total_tokens": result["total_tokens"],
            "valid_decision": result["decision"] in benchmark.QUESTIONS[row["task"]]["crit"],
            "api_error": result.get("error")}


def report(rows: list[dict], recorded: dict, cold_ms: float | None, device: str | None,
           glm_batch_ms: float | None, workers: int) -> dict:
    if len(recorded) != len(rows):
        raise ValueError(f"Need {len(rows)} measured cases; found {len(recorded)}")
    output = {"cases": len(rows), "glm_concurrency": workers,
              "laya_cold_start_ms": cold_ms, "laya_device": device,
              "tasks": {}}
    if glm_batch_ms is not None:
        output["glm_batch_ms"] = glm_batch_ms
    for task in ("route", "delivery", "overall"):
        subset = [recorded[row["id"]] for row in rows if task == "overall" or row["task"] == task]
        output["tasks"][task] = {
            "laya": stats([row["laya"]["ms"] for row in subset]),
            "glm": stats([row["glm"]["ms"] for row in subset]),
            "glm_retrying_cases": sum(row["glm"]["attempts"] > 1 for row in subset),
            "glm_invalid_or_error": sum(row["glm"].get("valid_decision") is False for row in subset),
        }
    SUMMARY.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True, help="Python executable with the installed Laya runtime")
    parser.add_argument("--workers", type=int, default=4, help="Concurrent GLM requests (default: 4)")
    args = parser.parse_args()
    if args.workers < 1 or args.workers > 8:
        parser.error("--workers must be between 1 and 8")
    rows = benchmark.prepare()
    recorded = {item["id"]: item for item in benchmark.read_jsonl(TIMINGS)} if TIMINGS.exists() else {}
    if any(item["id"] not in {row["id"] for row in rows} for item in recorded.values()):
        raise ValueError("Timing file contains an unknown case ID")
    missing = [row for row in rows if row["id"] not in recorded]
    if not missing:
        previous = json.loads(SUMMARY.read_text(encoding="utf-8")) if SUMMARY.exists() else {}
        output = report(rows, recorded, previous.get("laya_cold_start_ms"),
                        previous.get("laya_device"), None, args.workers)
        print(json.dumps(output, indent=2))
        return
    local, cold_ms, device = local_timings(missing, args.python)
    print(f"Local model ready: {device}; cold load {cold_ms:.0f} ms", flush=True)
    key = getpass.getpass("Temporary GLM key (not echoed or stored): ").strip()
    if not key:
        raise SystemExit("Missing temporary API key")
    began = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(glm_timing, row, key): row for row in missing}
        for index, future in enumerate(as_completed(futures), 1):
            row = futures[future]
            result = {"id": row["id"], "task": row["task"],
                      "laya": local[row["id"]], "glm": future.result()}
            benchmark.append_jsonl(TIMINGS, result)
            recorded[row["id"]] = result
            if index % 10 == 0 or index == len(missing):
                print(f"GLM timing: {index}/{len(missing)}", flush=True)
    output = report(rows, recorded, cold_ms, device,
                    round((time.perf_counter() - began) * 1000, 2) if len(missing) == len(rows) else None,
                    args.workers)
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
