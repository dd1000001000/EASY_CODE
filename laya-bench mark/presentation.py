"""Render accuracy, decision latency, and cloud-token cost in one figure."""
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from matplotlib.ticker import PercentFormatter


METHODS = ("Laya", "GLM", "Cascade")
LABELS = {"Laya": "Fine-tuned Laya", "GLM": "GLM", "Cascade": "Fine-tuned Laya + GLM"}
COLORS = {"Laya": "#2C7BE5", "GLM": "#A3A09A", "Cascade": "#16A879"}
INK = "#181B20"
MUTED = "#727780"
GRID = "#E9EAEC"


def render_report(folder: Path, rows: list[dict], metrics: dict, threshold: float) -> None:
    speed = json.loads((folder / "speed-summary.json").read_text(encoding="utf-8"))
    tasks = ("route", "delivery")
    total = len(rows)
    if speed["cases"] != total or any(speed["tasks"][task]["laya"]["count"] != 100 or
                                       speed["tasks"][task]["glm"]["count"] != 100 for task in tasks):
        raise ValueError("Speed and accuracy summaries must describe the same 100 + 100 cases")

    forwarded = [row for row in rows
                 if row["laya"]["scores"][row["laya"]["decision"]] < threshold]
    tokens = {"Laya": 0, "GLM": sum(row["glm"]["total_tokens"] for row in rows),
              "Cascade": sum(row["glm"]["total_tokens"] for row in forwarded)}
    accuracy = {method: sum(metrics[task][method]["correct"] for task in tasks) / total
                for method in METHODS}
    savings = 1 - tokens["Cascade"] / tokens["GLM"]
    warm_laya = speed["tasks"]["overall"]["laya"]["median_ms"] / 1000
    glm_api = speed["tasks"]["overall"]["glm"]["median_ms"] / 1000
    speed_ratio = glm_api / warm_laya

    with plt.rc_context({"font.family": "DejaVu Sans", "font.size": 11,
                         "text.color": INK, "axes.labelcolor": MUTED,
                         "xtick.color": MUTED, "ytick.color": MUTED,
                         "svg.fonttype": "none", "savefig.facecolor": "white"}):
        fig = plt.figure(figsize=(15, 10.2), facecolor="white")
        fig.text(.065, .948, "Fine-tuned Laya + GLM", fontsize=30, weight="bold")
        fig.text(.065, .91, f"100 routing + 100 delivery cases  ·  Local confidence gate {threshold:.2f}",
                 fontsize=13, color=MUTED)

        for x, value, label, detail in [
            (.065, f"{speed_ratio:.1f}×", "faster local decision", "warm CPU median vs GLM API"),
            (.405, f"{savings:.1%}", "fewer cloud tokens", "Fine-tuned Laya + GLM vs GLM-only"),
            (.735, f"{accuracy['Cascade']:.1%}", "cascade accuracy", f"GLM-only {accuracy['GLM']:.1%}"),
        ]:
            fig.text(x, .824, value, fontsize=29, weight="bold", color=COLORS["Cascade"])
            fig.text(x, .787, label, fontsize=12, weight="bold")
            fig.text(x, .766, detail, fontsize=10, color=MUTED)

        fig.text(.065, .715, "Accuracy", fontsize=17, weight="bold")
        fig.legend(handles=[Patch(facecolor=COLORS[m], label=LABELS[m]) for m in METHODS],
                   loc="upper left", bbox_to_anchor=(.06, .69), ncol=3,
                   frameon=False, fontsize=9, handlelength=1.2, columnspacing=.8)
        accuracy_ax = fig.add_axes([.07, .425, .55, .20])
        width = .23
        for index, method in enumerate(METHODS):
            values = [metrics[task][method]["accuracy"] for task in tasks] + [accuracy[method]]
            positions = [group + (index - 1) * width for group in range(3)]
            bars = accuracy_ax.bar(positions, values, width=width * .93,
                                   color=COLORS[method], zorder=3)
            for bar, value in zip(bars, values):
                accuracy_ax.text(bar.get_x() + bar.get_width() / 2, value + .018,
                                 f"{100 * value:g}%", ha="center", va="bottom", fontsize=10)
        accuracy_ax.set_xticks(range(3), ["Routing", "Delivery", "Overall"])
        accuracy_ax.set_ylim(0, 1.13)
        accuracy_ax.set_yticks([0, .25, .5, .75, 1])
        accuracy_ax.yaxis.set_major_formatter(PercentFormatter(1, decimals=0))
        accuracy_ax.grid(axis="y", color=GRID, linewidth=.8, zorder=0)
        accuracy_ax.tick_params(axis="both", length=0, pad=8)
        for spine in accuracy_ax.spines.values():
            spine.set_visible(False)

        fig.text(.70, .715, "Cloud tokens", fontsize=17, weight="bold")
        fig.text(.70, .684, "200 decisions · lower is better", fontsize=10, color=MUTED)
        token_ax = fig.add_axes([.70, .465, .26, .155])
        for y, method, label in [(1, "GLM", "GLM-only"), (0, "Cascade", "Fine-tuned Laya + GLM")]:
            token_ax.barh(y, tokens[method], height=.39, color=COLORS[method], zorder=3)
            token_ax.text(0, y + .28, label, va="center", fontsize=10)
            token_ax.text(tokens[method] + 1700, y, f"{tokens[method]:,}", va="center", fontsize=11)
        token_ax.set_xlim(0, tokens["GLM"] * 1.24)
        token_ax.set_ylim(-.45, 1.6)
        token_ax.set_yticks([])
        token_ax.set_xticks([0, 40_000, 80_000], ["0", "40k", "80k"])
        token_ax.grid(axis="x", color=GRID, linewidth=.8, zorder=0)
        token_ax.tick_params(axis="x", length=0, pad=8)
        for spine in token_ax.spines.values():
            spine.set_visible(False)
        fig.text(.70, .425, "Fine-tuned Laya alone: 0 cloud tokens", fontsize=10, color=MUTED)

        fig.text(.065, .353, "Decision latency", fontsize=17, weight="bold")
        fig.text(.065, .323, "Median per case · warm local CPU vs GLM API round trip · lower is better",
                 fontsize=10, color=MUTED)
        latency_ax = fig.add_axes([.16, .12, .76, .155])
        for index, task in enumerate((*tasks, "overall")):
            y = 2 - index
            local = speed["tasks"][task]["laya"]["median_ms"] / 1000
            remote = speed["tasks"][task]["glm"]["median_ms"] / 1000
            latency_ax.plot([local, remote], [y, y], color="#D8DFE7", lw=2.5, zorder=1)
            latency_ax.scatter([local], [y], color=COLORS["Laya"], s=110, zorder=3)
            latency_ax.scatter([remote], [y], color=COLORS["GLM"], s=110, zorder=3)
            latency_ax.annotate(f"{local:.3f}s", (local, y), xytext=(0, 13),
                                textcoords="offset points", ha="center", fontsize=10)
            latency_ax.annotate(f"{remote:.2f}s", (remote, y), xytext=(0, 13),
                                textcoords="offset points", ha="center", fontsize=10)
        latency_ax.set_xscale("log")
        latency_ax.set_xlim(.075, 15)
        latency_ax.set_xticks([.1, .3, 1, 3, 10], ["0.1s", "0.3s", "1s", "3s", "10s"])
        latency_ax.set_yticks([2, 1, 0], ["Routing", "Delivery", "Overall"])
        latency_ax.set_ylim(-.5, 2.55)
        latency_ax.grid(axis="x", which="major", color=GRID, linewidth=.8, zorder=0)
        latency_ax.tick_params(axis="both", length=0, pad=10)
        for spine in latency_ax.spines.values():
            spine.set_visible(False)

        fig.text(.065, .052,
                 f"Fine-tuned Laya joint-v2 · Warm CPU latency excludes {speed['laya_cold_start_ms'] / 1000:.1f}s cold load. "
                 "Cascade latency was not directly measured.", fontsize=9, color=MUTED)
        fig.savefig(folder / "benchmark-overview.png", dpi=180)
        fig.savefig(folder / "benchmark-overview.svg")
        plt.close(fig)

    lines = [
        "# Fine-tuned Laya + GLM", "",
        f"100 routing + 100 delivery cases. Fine-tuned Laya (joint-v2) decides first; "
        f"confidence below **{threshold:.2f}** sends the case to GLM.", "",
        "![Fine-tuned Laya benchmark: accuracy, speed, and cloud tokens](benchmark-overview.png)", "",
        f"Fine-tuned Laya's warm CPU decision median was **{warm_laya:.3f}s**, versus "
        f"**{glm_api:.2f}s** for a GLM API decision (**{speed_ratio:.1f}×**). "
        f"The cascade used **{tokens['Cascade']:,}** rather than **{tokens['GLM']:,}** "
        f"cloud tokens (**{savings:.1%} fewer**), with **{accuracy['Cascade']:.1%}** overall "
        f"accuracy versus **{accuracy['GLM']:.1%}** for GLM-only.", "",
        "Speed is median wall time on the same 200 inputs, measured separately from accuracy. "
        f"Local inference used a loaded CPU model (cold load {speed['laya_cold_start_ms'] / 1000:.1f}s); "
        f"GLM API timings include network latency with {speed['glm_concurrency']} concurrent calls. "
        "Cascade latency was not directly measured. "
        "[Decision results](results.jsonl) · [Per-case timings](speed-results.jsonl) · "
        "[Speed summary](speed-summary.json).", "",
    ]
    (folder / "README.md").write_text("\n".join(lines), encoding="utf-8")
