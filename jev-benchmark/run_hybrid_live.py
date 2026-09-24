"""Run Laya first and call GLM only for cases rejected by the 0.90 gate.

The fine-tuned arm runs first. The base-model arm reuses GLM results for shared
fallback cases and requests only cases not already queried in this run.
The key is entered interactively and never written to disk.
"""

from __future__ import annotations

import argparse
import getpass
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


from benchmark_data import QUESTIONS, verified_rows
from laya_eval import evaluate
from run_v10_glm import request_one


ROOT = Path(__file__).resolve().parent
MODEL_ROOT = ROOT.parent / "model-weights" / "laya-multilingual"
MODELS = {
    "finetuned": MODEL_ROOT / "finetuned",
    "base": MODEL_ROOT / "base",
}
LOCAL_FILES = {name: ROOT / f"hybrid_laya_{name}.json" for name in MODELS}
GLM_FILE = ROOT / "hybrid_glm_results.jsonl"
SUMMARY_FILE = ROOT / "hybrid_live_summary.json"
THRESHOLD = 0.90


def local_decision(case: dict) -> tuple[bool, str, float]:
    orders = case["orders"]
    label = orders[0]["predicted"]
    minimum = min(order["probabilities"][label] for order in orders)
    accepted = (case["task"] != "route" and
                len({order["predicted"] for order in orders}) == 1 and
                minimum >= THRESHOLD)
    return accepted, label, minimum


def load_local_reports() -> dict[str, dict]:
    reports = {}
    for name, model in MODELS.items():
        report = evaluate(model, batch_size=16, seed=271828)
        reports[name] = report
        LOCAL_FILES[name].write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                                     encoding="utf-8")
        print(f"Laya {name} evaluated: {len(report['cases'])} cases", flush=True)
    return reports


def load_cached(ids: set[str]) -> dict[str, dict]:
    if not GLM_FILE.exists():
        return {}
    records = [json.loads(line) for line in GLM_FILE.read_text(encoding="utf-8").splitlines()
               if line.strip()]
    if len({item["id"] for item in records}) != len(records) or any(item["id"] not in ids for item in records):
        raise ValueError("Hybrid GLM cache contains duplicate or unknown case IDs")
    return {item["id"]: item for item in records}


def save_cached(rows: list[dict], cache: dict[str, dict]) -> None:
    temp = GLM_FILE.with_suffix(".tmp")
    temp.write_text("".join(json.dumps(cache[row["id"]], ensure_ascii=False) + "\n"
                            for row in rows if row["id"] in cache), encoding="utf-8")
    temp.replace(GLM_FILE)


def get_glm(key: str, rows: list[dict], all_rows: list[dict], order: dict[str, list[str]],
            cache: dict[str, dict], concurrency: int, timeout: int) -> None:
    pending = [row for row in rows if row["id"] not in cache or cache[row["id"]]["status"] != "ok"]
    if not pending:
        return

    def record_result(record: dict) -> None:
        previous = cache.get(record["id"])
        if previous and previous["status"] != "ok":
            record["prior_attempts"] = [*previous.get("prior_attempts", []), {
                field: previous[field] for field in ("status", "http_status", "error_type",
                                              "finish_reason", "content_chars", "elapsed_seconds")
                if field in previous
            }]
        cache[record["id"]] = record
        save_cached(all_rows, cache)
        print(f"GLM {record['task']} {record['id']}: {record['status']} "
              f"{record.get('decision', '')}", flush=True)

    # Probe one request before parallel dispatch, so an expired key does not
    # generate a full batch of failed requests.
    first = request_one(key, pending[0], order[pending[0]["id"]], timeout)
    if first["status"] == "http_error" and first.get("http_status") in {401, 403}:
        raise RuntimeError("GLM Coding Plan key was rejected; no batch was started")
    record_result(first)
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(request_one, key, row, order[row["id"]], timeout)
                   for row in pending[1:]]
        for future in as_completed(futures):
            record_result(future.result())


def summarize(rows: list[dict], reports: dict[str, dict], cache: dict[str, dict],
              needed: dict[str, set[str]]) -> dict:
    summary = {"threshold": THRESHOLD, "route_policy": "GLM only",
               "unique_glm_cases": len(cache),
               "glm_requests_including_retries": sum(1 + len(item.get("prior_attempts", []))
                                                    for item in cache.values()),
               "glm_prompt_tokens_recorded": sum(item.get("prompt_tokens") or 0 for item in cache.values()),
               "glm_completion_tokens_recorded": sum(item.get("completion_tokens") or 0 for item in cache.values()),
               "arms": {}}
    for name, report in reports.items():
        local = {case["id"]: case for case in report["cases"]}
        task_results = {}
        for task in QUESTIONS:
            cases = [row for row in rows if row["task"] == task]
            confusion = Counter()
            accepted = 0
            accepted_errors = 0
            for row in cases:
                case_id = row["id"]
                use_laya, label, _ = local_decision(local[case_id])
                if use_laya:
                    accepted += 1
                    accepted_errors += label != row["answer"]["decision"]
                predicted = label if use_laya else cache[case_id]["decision"]
                confusion[(row["answer"]["decision"], predicted)] += 1
            task_results[task] = {
                "cases": len(cases), "laya_accepted": accepted,
                "laya_accepted_errors": accepted_errors,
                "glm_fallback": sum(row["id"] in needed[name] for row in cases),
                "correct": sum(n for (expected, predicted), n in confusion.items()
                               if expected == predicted),
                "confusion": {f"{a}->{b}": n for (a, b), n in sorted(confusion.items())},
            }
        summary["arms"][name] = task_results
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--local-only", action="store_true",
                        help="Run both Laya models and print gate counts without GLM requests")
    args = parser.parse_args()
    if args.concurrency < 1 or args.timeout_seconds < 1:
        parser.error("concurrency and timeout must be positive")
    rows = verified_rows()
    reports = load_local_reports()
    order = {}
    needed = {}
    for name, report in reports.items():
        cases = {case["id"]: case for case in report["cases"]}
        if set(cases) != {row["id"] for row in rows}:
            raise ValueError(f"Laya {name} test IDs do not match the frozen set")
        needed[name] = {case_id for case_id, case in cases.items()
                        if not local_decision(case)[0]}
        for case_id, case in cases.items():
            current = case["orders"][0]["order"]
            if case_id in order and order[case_id] != current:
                raise ValueError(f"Laya option order differs between arms: {case_id}")
            order[case_id] = current
        print(f"{name}: {len(rows) - len(needed[name])} Laya decisions, "
              f"{len(needed[name])} GLM fallbacks", flush=True)
    if args.local_only:
        return

    cache = load_cached({row["id"] for row in rows})
    missing_fine = [row for row in rows if row["id"] in needed["finetuned"] and
                    (row["id"] not in cache or cache[row["id"]]["status"] != "ok")]
    missing_base = [row for row in rows if row["id"] in needed["base"] and
                    (row["id"] not in cache or cache[row["id"]]["status"] != "ok")]
    if missing_fine or missing_base:
        key = getpass.getpass("GLM Coding Plan API key (not stored): ").strip()
        if not key:
            raise ValueError("API key cannot be empty")
        # The first arm performs real conditional fallback calls. The second
        # arm reuses those results and queries only its additional case IDs.
        get_glm(key, [row for row in rows if row["id"] in needed["finetuned"]],
                rows, order, cache, args.concurrency, args.timeout_seconds)
        get_glm(key, [row for row in rows if row["id"] in needed["base"]],
                rows, order, cache, args.concurrency, args.timeout_seconds)
    relevant = needed["finetuned"] | needed["base"]
    failures = [case_id for case_id in relevant if case_id not in cache or cache[case_id]["status"] != "ok"]
    if failures:
        raise RuntimeError(f"Incomplete GLM fallback results: {len(failures)}; rerun to resume")
    summary = summarize(rows, reports, cache, needed)
    SUMMARY_FILE.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
