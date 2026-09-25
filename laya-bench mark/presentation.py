"""Render the measured benchmark as a compact, shareable results sheet."""
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


def render_report(folder: Path, rows: list[dict], metrics: dict, threshold: float) -> None:
    tasks = ("route", "delivery")
    total = len(rows)
    forwarded = [row for row in rows
                 if row["laya"]["scores"][row["laya"]["decision"]] < threshold]
    tokens = {"Laya": 0, "GLM": sum(row["glm"]["total_tokens"] for row in rows),
              "Cascade": sum(row["glm"]["total_tokens"] for row in forwarded)}
    accuracy = {method: sum(metrics[task][method]["correct"] for task in tasks) / total
                for method in METHODS}
    false_releases = {method: metrics["delivery"][method]["matrix"]["CHALLENGE"]["RELEASE"]
                      for method in METHODS}
    negative_count = sum(row["task"] == "delivery" and row["expected"] == "CHALLENGE"
                         for row in rows)
    savings = 1 - tokens["Cascade"] / tokens["GLM"]
    call_reduction = 1 - len(forwarded) / total
    accuracy_delta = 100 * (accuracy["Cascade"] - accuracy["GLM"])

    with plt.rc_context({"font.family": "DejaVu Sans", "font.size": 11,
                         "text.color": INK, "axes.labelcolor": MUTED,
                         "xtick.color": MUTED, "ytick.color": MUTED,
                         "svg.fonttype": "none", "savefig.facecolor": "white"}):
        fig = plt.figure(figsize=(15, 9.6), facecolor="white")
        fig.text(.065, .955, "Fine-tuned Laya + GLM", fontsize=31, weight="bold")
        fig.text(.065, .918, "Joint SFT checkpoint · Local decisions with selective cloud fallback", fontsize=15, color=MUTED)
        fig.text(.065, .883,
                 f"100 routing + 100 delivery cases   /   Confidence threshold {threshold:.2f}",
                 fontsize=11, color=MUTED)

        fig.text(.065, .828, "Accuracy by task", fontsize=16, weight="bold")
        fig.legend(handles=[Patch(facecolor=COLORS[m], label=LABELS[m]) for m in METHODS],
                   loc="upper left", bbox_to_anchor=(.06, .81), ncol=3,
                   frameon=False, fontsize=10, handlelength=1.2, columnspacing=1.2)
        ax = fig.add_axes([.065, .505, .535, .255])
        width = .23
        for index, method in enumerate(METHODS):
            values = [metrics[task][method]["accuracy"] for task in tasks] + [accuracy[method]]
            positions = [group + (index - 1) * width for group in range(3)]
            bars = ax.bar(positions, values, width=width * .93, color=COLORS[method], zorder=3)
            for bar, value in zip(bars, values):
                ax.text(bar.get_x() + bar.get_width() / 2, value + .018,
                        f"{100 * value:g}%", ha="center", va="bottom", fontsize=11,
                        weight="bold" if method == "Cascade" else "normal")
        ax.set_xticks(range(3), ["Routing", "Delivery", "Overall"])
        ax.set_ylim(0, 1.12)
        ax.set_yticks([0, .25, .5, .75, 1])
        ax.yaxis.set_major_formatter(PercentFormatter(1, decimals=0))
        ax.grid(axis="y", color="#E9EAEC", linewidth=.8, zorder=0)
        ax.tick_params(axis="both", length=0, pad=9)
        for spine in ax.spines.values():
            spine.set_visible(False)

        fig.text(.675, .828, "What the cascade changes", fontsize=16, weight="bold")
        for y, value, label, detail in [
            (.752, f"{savings:.1%}", "fewer cloud tokens", f"{tokens['GLM']:,} → {tokens['Cascade']:,}"),
            (.642, f"{call_reduction:.0%}", "fewer GLM calls", f"{total} → {len(forwarded)} requests"),
            (.532, f"{accuracy['Cascade']:.1%}", "overall accuracy",
             f"{abs(accuracy_delta):.1f} pp {'below' if accuracy_delta < 0 else 'above'} GLM-only"),
        ]:
            fig.text(.675, y, value, fontsize=30, weight="bold", color=COLORS["Cascade"])
            fig.text(.818, y + .014, label, fontsize=11, weight="bold")
            fig.text(.818, y - .012, detail, fontsize=10, color=MUTED)

        fig.text(.065, .409, "Cloud tokens for 200 decisions", fontsize=16, weight="bold")
        fig.text(.065, .378, "Reported input + output tokens · lower is better", fontsize=10, color=MUTED)
        token_ax = fig.add_axes([.165, .14, .405, .202])
        for y, method in [(1, "GLM"), (0, "Cascade")]:
            token_ax.barh(y, tokens[method], height=.48, color=COLORS[method], zorder=3)
            token_ax.text(tokens[method] + tokens["GLM"] * .025, y,
                          f"{tokens[method]:,}", va="center", fontsize=12, weight="bold")
        token_ax.set_yticks([1, 0], ["GLM", "Fine-tuned Laya\n+ GLM"])
        token_ax.set_ylim(-.65, 1.65)
        token_ax.set_xlim(0, tokens["GLM"] * 1.25)
        token_ax.set_xticks([0, 20_000, 40_000, 60_000, 80_000], ["0", "20k", "40k", "60k", "80k"])
        token_ax.grid(axis="x", color="#E9EAEC", linewidth=.8, zorder=0)
        token_ax.tick_params(axis="both", length=0, pad=8)
        for spine in token_ax.spines.values():
            spine.set_visible(False)
        fig.text(.065, .098, "Fine-tuned Laya alone uses 0 cloud tokens.", fontsize=10, color=MUTED)

        fig.text(.675, .409, "Incorrect delivery approvals", fontsize=16, weight="bold")
        fig.text(.675, .378, f"{negative_count} cases requiring correction · lower is better",
                 fontsize=10, color=MUTED)
        fail_ax = fig.add_axes([.69, .14, .275, .202])
        for x, method in enumerate(METHODS):
            value = false_releases[method]
            fail_ax.bar(x, value, width=.53, color=COLORS[method], zorder=3)
            fail_ax.text(x, value + .45, str(value), ha="center", va="bottom", fontsize=13, weight="bold")
        fail_ax.set_xticks(range(3), ["Fine-tuned\nLaya", "GLM", "Fine-tuned Laya\n+ GLM"], fontsize=9)
        fail_ax.set_ylim(0, max(false_releases.values()) + 4)
        fail_ax.set_yticks([0, 5, 10, 15])
        fail_ax.grid(axis="y", color="#E9EAEC", linewidth=.8, zorder=0)
        fail_ax.tick_params(axis="both", length=0, pad=8)
        for spine in fail_ax.spines.values():
            spine.set_visible(False)

        fig.text(.065, .035,
                 "Fine-tuned Laya joint-v2 + GLM-5.3-Flash · Same held-out cases · Cascade reuses recorded GLM answers",
                 fontsize=9, color=MUTED)
        fig.savefig(folder / "benchmark-overview.png", dpi=180)
        fig.savefig(folder / "benchmark-overview.svg")
        plt.close(fig)

    lines = ["# Fine-tuned Laya + GLM", "",
             f"100 routing + 100 delivery cases. Fine-tuned Laya (joint-v2) decides first; confidence below **{threshold:.2f}** sends the case to GLM.",
             "", "![Fine-tuned Laya and GLM benchmark results](benchmark-overview.png)", "",
             "| Method | Routing accuracy | Delivery accuracy | Overall accuracy | Cloud tokens |",
             "| --- | ---: | ---: | ---: | ---: |"]
    for method in METHODS:
        lines.append(f"| {LABELS[method]} | {metrics['route'][method]['accuracy']:.1%} | "
                     f"{metrics['delivery'][method]['accuracy']:.1%} | {accuracy[method]:.1%} | {tokens[method]:,} |")
    lines += ["", f"The cascade cuts cloud tokens by **{savings:.1%}** and GLM calls from **{total} to {len(forwarded)}**. "
              f"Overall accuracy is **{abs(accuracy_delta):.1f} percentage points {'lower' if accuracy_delta < 0 else 'higher'}** than GLM-only.",
              "", f"Incorrect approvals among {negative_count} delivery cases requiring correction: "
              f"**Fine-tuned Laya {false_releases['Laya']} · GLM {false_releases['GLM']} · Fine-tuned Laya + GLM {false_releases['Cascade']}**.",
              "", "Fine-tuned Laya joint-v2 and GLM-5.3-Flash, evaluated on the same held-out cases. "
              "Cascade results reuse each case's recorded GLM answer and token usage.", ""]
    (folder / "README.md").write_text("\n".join(lines), encoding="utf-8")
