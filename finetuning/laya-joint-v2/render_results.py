"""Render the saved SFT report without loading models or running evaluation."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Patch
from matplotlib.ticker import PercentFormatter

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE.parents[1] / "model-weights/laya-multilingual/joint-v2/report.json"
TASKS = {"route": ("DIRECT", "PLAN", "CODE"), "delivery": ("RELEASE", "CHALLENGE")}
BLUE = "#2C7BE5"
GREEN = "#16A879"
GRAY = "#A3A09A"
INK = "#181B20"
MUTED = "#727780"


def read_results(path: Path) -> dict:
    results = json.loads(path.read_text(encoding="utf-8"))["held_out_test"]
    for stage in ("baseline", "trained"):
        for task, labels in TASKS.items():
            item = results[stage][task]
            matrix = item["confusion"]
            total = sum(matrix[actual][predicted] for actual in labels for predicted in labels)
            correct = sum(matrix[label][label] for label in labels)
            if total != item["total_orders"] or correct != item["correct_orders"]:
                raise ValueError(f"Confusion counts disagree with saved metrics: {stage}/{task}")
            if abs(correct / total - item["accuracy"]) > 1e-9:
                raise ValueError(f"Accuracy disagrees with saved counts: {stage}/{task}")
    return results


def render(results: dict, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    trained = results["trained"]
    with plt.rc_context({"font.family": "DejaVu Sans", "font.size": 11,
                         "text.color": INK, "axes.labelcolor": MUTED,
                         "xtick.color": MUTED, "ytick.color": MUTED,
                         "svg.fonttype": "none", "savefig.facecolor": "white"}):
        fig = plt.figure(figsize=(14, 10.8), facecolor="white")
        fig.text(.075, .951, "Fine-tuning Laya", fontsize=31, weight="bold")
        fig.text(.075, .916, "Joint routing + delivery decisions", fontsize=15, color=MUTED)
        fig.text(.075, .883,
                 f"{trained['route']['cases']} routing cases × 6 answer orders   /   "
                 f"{trained['delivery']['cases']} delivery cases × 2 answer orders", fontsize=11, color=MUTED)

        fig.text(.075, .824, "Accuracy before and after SFT", fontsize=16, weight="bold")
        fig.legend(handles=[Patch(facecolor=GRAY, label="Original Laya multilingual"),
                            Patch(facecolor=BLUE, label="After joint SFT")],
                   loc="upper left", bbox_to_anchor=(.068, .809), ncol=2,
                   frameon=False, fontsize=10, handlelength=1.2)
        ax = fig.add_axes([.075, .535, .51, .225])
        for offset, stage, color in [(-.17, "baseline", GRAY), (.17, "trained", BLUE)]:
            values = [results[stage][task]["accuracy"] for task in TASKS]
            bars = ax.bar(np.arange(2) + offset, values, width=.29, color=color, zorder=3)
            for bar, value in zip(bars, values):
                ax.text(bar.get_x() + bar.get_width() / 2, value + .022, f"{value:.1%}",
                        ha="center", fontsize=13, weight="bold" if stage == "trained" else "normal")
        ax.set_xticks([0, 1], ["Routing", "Delivery"])
        ax.set_ylim(0, 1.12)
        ax.set_yticks([0, .25, .5, .75, 1])
        ax.yaxis.set_major_formatter(PercentFormatter(1, decimals=0))
        ax.grid(axis="y", color="#E9EAEC", linewidth=.8, zorder=0)
        ax.tick_params(axis="both", length=0, pad=9)
        for spine in ax.spines.values():
            spine.set_visible(False)

        fig.text(.68, .824, "Measured improvement", fontsize=16, weight="bold")
        for y, task, name in [(.713, "route", "routing accuracy"), (.586, "delivery", "delivery accuracy")]:
            delta = 100 * (trained[task]["accuracy"] - results["baseline"][task]["accuracy"])
            fig.text(.68, y, f"{delta:+.1f} pp", fontsize=31, weight="bold", color=GREEN)
            fig.text(.68, y - .032, name, fontsize=12, weight="bold")
            fig.text(.68, y - .059,
                     f"{results['baseline'][task]['correct_orders']} → {trained[task]['correct_orders']} "
                     f"correct / {trained[task]['total_orders']} evaluations", fontsize=10, color=MUTED)

        fig.text(.075, .431, "Where the fine-tuned model gets it right", fontsize=16, weight="bold")
        fig.text(.075, .400, "Rows = expected · columns = predicted · each cell shows count and row percentage",
                 fontsize=10, color=MUTED)
        for left, task, name in [(.16, "route", "Routing"), (.65, "delivery", "Delivery")]:
            labels = TASKS[task]
            counts = np.array([[trained[task]["confusion"][actual][predicted]
                                for predicted in labels] for actual in labels])
            shares = counts / counts.sum(axis=1, keepdims=True)
            heat = fig.add_axes([left, .126, .255, .24])
            heat.imshow(shares, cmap="Blues", vmin=0, vmax=1, interpolation="nearest")
            heat.set_title(name, fontsize=13, weight="bold", pad=12)
            heat.set_xticks(range(len(labels)), labels, fontsize=10)
            heat.set_yticks(range(len(labels)), labels, fontsize=10)
            heat.tick_params(axis="both", length=0, pad=9)
            heat.set_xlabel("Predicted", fontsize=10, labelpad=10)
            heat.set_ylabel("Expected", fontsize=10, labelpad=10)
            heat.set_xticks(np.arange(-.5, len(labels), 1), minor=True)
            heat.set_yticks(np.arange(-.5, len(labels), 1), minor=True)
            heat.grid(which="minor", color="white", linewidth=3)
            heat.tick_params(which="minor", bottom=False, left=False)
            for spine in heat.spines.values():
                spine.set_visible(False)
            for i in range(len(labels)):
                for j in range(len(labels)):
                    color = "white" if shares[i, j] > .55 else INK
                    heat.text(j, i - .08, str(counts[i, j]), ha="center", va="center",
                              fontsize=19, weight="bold", color=color)
                    heat.text(j, i + .2, f"{shares[i, j]:.1%}", ha="center", va="center",
                              fontsize=11, color=color)
        fig.text(.075, .035,
                 "Laya multilingual · Full-parameter SFT · GPT-6 Luna-sourced data · Darker cells = larger share within a row",
                 fontsize=9, color=MUTED)
        fig.savefig(output / "results.png", dpi=180)
        fig.savefig(output / "results.svg")
        plt.close(fig)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--output", type=Path, default=HERE / "assets")
    args = parser.parse_args()
    render(read_results(args.report), args.output)
    print(f"Charts saved to {args.output.resolve()}")
