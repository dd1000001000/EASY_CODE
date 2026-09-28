"""Matched upstream / full SFT / LoRA accuracy, all CPU FP32 ONNX."""
import argparse
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter
from compare_backends import flatten

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

def read_results(paths):
    results = {name: json.loads(path.read_text(encoding="utf-8")) for name, path in paths.items()}
    reference = next(iter(results.values()))
    keys = flatten(reference).keys()
    for name, report in results.items():
        if report["backend"] != "onnx-fp32-cpu" or report["dataset_sha256"] != reference["dataset_sha256"]:
            raise ValueError("Comparisons require the same dataset and CPU FP32 ONNX backend")
        if flatten(report).keys() != keys:
            raise ValueError("Comparisons require identical cases and answer orders")
        for task in ("route", "delivery"):
            item = report["by_task"][task]
            matrix = item["confusion"]
            total = sum(sum(row.values()) for row in matrix.values())
            correct = sum(matrix[label][label] for label in matrix)
            if (total != item["total_orders"] or correct != item["correct_orders"]
                    or abs(correct / total - item["accuracy"]) > 1e-9):
                raise ValueError(f"Confusion counts disagree: {name}/{task}")
    return results

def render(results, output):
    output.mkdir(parents=True, exist_ok=True)
    with plt.rc_context({"font.family": "DejaVu Sans", "svg.fonttype": "none"}):
        fig, axes = plt.subplots(1, 2, figsize=(12, 5.5))
        fig.suptitle("Laya accuracy: upstream / full SFT / LoRA", fontsize=20, weight="bold")
        for ax, task, title in zip(axes, ("route", "delivery"), ("Routing · 630 trials", "Delivery · 342 trials")):
            values = [report["by_task"][task]["accuracy"] for report in results.values()]
            bars = ax.bar(list(results), values, color=["#A3A09A", "#6A8CC7", "#2C7BE5"])
            ax.bar_label(bars, labels=[f"{value:.2%}" for value in values], padding=6, fontsize=12)
            ax.set_ylim(0, 1.13)
            ax.yaxis.set_major_formatter(PercentFormatter(1))
            ax.set_title(title, pad=18)
            ax.spines[["top", "right"]].set_visible(False)
            ax.set_axisbelow(True)
            ax.grid(axis="y", alpha=.15)
        fig.text(.5, .035, "Same 276 held-out cases and answer orders · all CPU FP32 ONNX · single training seed",
                 ha="center", fontsize=10, color="#727780")
        fig.subplots_adjust(top=.8, bottom=.15, wspace=.25)
        fig.savefig(output / "results.png", dpi=180)
        fig.savefig(output / "results.svg")
        svg = output / "results.svg"
        svg.write_text("\n".join(line.rstrip() for line in svg.read_text(encoding="utf-8").splitlines()) + "\n", encoding="utf-8")
        plt.close(fig)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", type=Path, default=ROOT / "model-weights/laya-multilingual/joint-v2/onnx-evaluation.json")
    parser.add_argument("--upstream", type=Path, default=HERE / "experiments/upstream-reference/onnx-evaluation.json")
    parser.add_argument("--sft", type=Path, default=HERE / "experiments/full-sft-reference/onnx-evaluation.json")
    parser.add_argument("--output", type=Path, default=HERE / "assets")
    args = parser.parse_args()
    render(read_results({"Upstream": args.upstream, "Full SFT": args.sft, "LoRA": args.current}), args.output)
