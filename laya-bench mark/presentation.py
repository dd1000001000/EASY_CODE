"""GLM API versus released LoRA: cloud tokens and decision latency only."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

def comparison_data(rows, speed):
    if len(rows) != 200 or len({row["id"] for row in rows}) != 200 or speed["cases"] != 200:
        raise ValueError("Need the same 200 frozen cases")
    if any(not row["glm"]["usage_reported"] for row in rows):
        raise ValueError("Missing GLM token usage")
    hashes = {row["laya"]["weight_sha256"] for row in rows}
    if len(hashes) != 1 or speed.get("local_model_sha256") not in hashes:
        raise ValueError("Decision and speed records use different local weights")
    return {"cases": 200, "model_sha256": next(iter(hashes)),
            "glm": {key: sum(row["glm"][key] for row in rows)
                    for key in ("prompt_tokens", "completion_tokens", "total_tokens")},
            "lora": {"cloud_tokens": 0, "input_text_tokens": sum(row["laya"]["input_tokens"] for row in rows)},
            "speed": speed["tasks"]["overall"], "cold_start_ms": speed["laya_cold_start_ms"],
            "glm_source": "Historical API response records and separate API timing run; no fresh requests",
            "token_scope": "Local input-text tokens exclude fixed criteria/options; tokenizers differ"}

def save_figure(fig, path):
    fig.savefig(path.with_suffix(".png"), dpi=180)
    fig.savefig(path.with_suffix(".svg"))
    svg = path.with_suffix(".svg")
    svg.write_text("\n".join(line.rstrip() for line in svg.read_text(encoding="utf-8").splitlines()) + "\n", encoding="utf-8")
    plt.close(fig)

def render_report(folder: Path, rows, speed):
    data = comparison_data(rows, speed)
    cloud = data["glm"]["total_tokens"]
    local_ms = data["speed"]["laya"]["median_ms"]
    glm_ms = data["speed"]["glm"]["median_ms"]
    with plt.rc_context({"font.family": "DejaVu Sans", "svg.fonttype": "none"}):
        fig, axes = plt.subplots(1, 2, figsize=(12, 5.5))
        fig.suptitle("GLM API vs LoRA Laya ONNX", fontsize=21, weight="bold")
        names, colors = ["GLM API\n(recorded)", "LoRA ONNX\n(local CPU)"], ["#A3A09A", "#2C7BE5"]
        for ax, values, title, labels in (
                (axes[0], [cloud, 0], "Cloud tokens · 200 decisions", [f"{cloud:,}", "0"]),
                (axes[1], [glm_ms / 1000, local_ms / 1000], "Warm decision median · seconds",
                 [f"{glm_ms / 1000:.3f}s", f"{local_ms / 1000:.3f}s"])):
            bars = ax.bar(names, values, color=colors)
            ax.bar_label(bars, labels=labels, padding=6, fontsize=12)
            ax.set_ylim(0, max(values) * 1.22)
            ax.spines[["top", "right"]].set_visible(False)
            ax.set_title(title, pad=16)
            ax.set_axisbelow(True)
            ax.grid(axis="y", alpha=.15)
        fig.text(.5, .035, "Historical GLM records vs current local rerun · local models still tokenize inputs · no cascade",
                 ha="center", fontsize=9, color="#727780")
        fig.subplots_adjust(top=.8, bottom=.2, wspace=.3)
        save_figure(fig, folder / "benchmark-overview")
        fig, ax = plt.subplots(figsize=(10, 5))
        for offset, method, label, color in ((-.18, "glm", "GLM API (recorded)", "#A3A09A"),
                                            (.18, "laya", "LoRA ONNX (CPU)", "#2C7BE5")):
            values = [speed["tasks"][task][method]["median_ms"] / 1000 for task in ("route", "delivery", "overall")]
            bars = ax.bar([p + offset for p in range(3)], values, width=.34, label=label, color=color)
            ax.bar_label(bars, labels=[f"{value:.3f}s" for value in values], padding=5)
        ax.set_xticks(range(3), ["Routing", "Delivery", "Overall"])
        ax.set_ylabel("Median seconds per decision")
        ax.set_title("GLM API vs LoRA: decision latency")
        ax.set_ylim(0, max(speed["tasks"][task]["glm"]["median_ms"] / 1000 for task in ("route", "delivery")) * 1.35)
        ax.legend(frameon=False)
        ax.spines[["top", "right"]].set_visible(False)
        fig.tight_layout()
        save_figure(fig, folder / "speed-overview")
    (folder / "comparison-summary.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    lines = ["# GLM API vs LoRA Laya ONNX", "",
             "![Cloud tokens and decision latency](benchmark-overview.png)", "",
             "Upstream / full SFT / LoRA accuracy is in the [training comparison](../finetuning/laya-joint-v2/README.md). This report compares only tokens and speed, not a cascade.", "",
             "| Metric | GLM API (historical) | LoRA ONNX (current local rerun) |",
             "| --- | ---: | ---: |",
             f"| Cloud input tokens, 200 cases | {data['glm']['prompt_tokens']:,} | 0 |",
             f"| Cloud output tokens, 200 cases | {data['glm']['completion_tokens']:,} | 0 |",
             f"| Total cloud tokens | {cloud:,} | 0 |",
             f"| Warm median | {glm_ms / 1000:.3f}s | {local_ms / 1000:.3f}s |",
             f"| P95 | {data['speed']['glm']['p95_ms'] / 1000:.3f}s | {data['speed']['laya']['p95_ms'] / 1000:.3f}s |", "",
             f"Local cold startup: {data['cold_start_ms'] / 1000:.3f}s, excluded from warm median. "
             f"Local input-text tokens: {data['lora']['input_text_tokens']:,}, excluding fixed criteria/options. "
             "Zero cloud tokens does not mean zero local computation. Different tokenizers and prompt templates make token counts non-interchangeable.", "",
             "The same 100 routing + 100 delivery inputs are used. Local latency includes tokenization and IPC; "
             "GLM latency includes network round trips with four concurrent requests. GLM token and timing records "
             "came from separate historical runs; no new API requests were made. This is not a same-time controlled "
             "comparison. The local model classifies choices, rather than generating answers like GLM.", "",
             "![Latency by task](speed-overview.png)", "",
             "[Decisions](results.jsonl) · [Timings](speed-results.jsonl) · [Summary](comparison-summary.json)", "",
             "Reproduce: `python benchmark.py --refresh-local --python <onnx-python>`, "
             "`python speed.py --refresh-local --python <onnx-python>`, then `python benchmark.py --report`. "
             "Plotting needs matplotlib; inference needs ONNX Runtime and tokenizers.", ""]
    (folder / "README.md").write_text("\n".join(lines), encoding="utf-8")
