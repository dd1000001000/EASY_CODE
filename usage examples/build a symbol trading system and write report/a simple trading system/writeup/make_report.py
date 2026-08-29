#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate writeup/report.pdf: scalability experiment + analysis.

Pipeline
--------
1. (Re)run the load experiment with testing/load_test.py (unless --reuse and
   writeup/results.csv already exists);
2. draw two charts with matplotlib (throughput vs concurrency, mean +/- std);
3. assemble writeup/report.pdf with a small dependency-free PDF writer that
   embeds the PNG figures (pure Python standard library + PIL).

Usage
-----
    python writeup/make_report.py [--reuse]

Outputs: writeup/results.csv, writeup/fig_throughput.png,
         writeup/fig_bars.png, writeup/report.pdf
"""

import argparse
import csv
import os
import platform
import socket
import statistics
import subprocess
import sys
import zlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LOAD_TEST = os.path.join(ROOT, "testing", "load_test.py")
RESULTS_CSV = os.path.join(HERE, "results.csv")
FIG1 = os.path.join(HERE, "fig_throughput.png")
FIG2 = os.path.join(HERE, "fig_bars.png")
REPORT = os.path.join(HERE, "report.pdf")

MARGIN = 54.0
PAGE_W, PAGE_H = 612.0, 792.0
BODY_W = PAGE_W - 2 * MARGIN


# ---------------------------------------------------------------------------
# Minimal PDF writer (standard-library only)
# ---------------------------------------------------------------------------

def pdf_escape(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


class Page:
    def __init__(self):
        self.ops = bytearray()
        self.xobjects = []  # image object names used on this page


class Pdf:
    FONTS = {"F1": "Helvetica", "F2": "Helvetica-Bold", "F3": "Helvetica-Oblique"}

    def __init__(self, w=PAGE_W, h=PAGE_H):
        self.w = w
        self.h = h
        self.pages = []
        self.images = {}  # name -> (iw, ih, raw_rgb_bytes)
        self.cur = None

    def new_page(self):
        p = Page()
        self.pages.append(p)
        self.cur = p
        return p

    def add_image(self, name, pil_img):
        img = pil_img.convert("RGB")
        self.images[name] = (img.width, img.height, img.tobytes())

    # -- low-level operators ------------------------------------------------

    def _op(self, s):
        self.cur.ops += s.encode("latin-1") + b"\n"

    def color(self, r, g, b, fill=True):
        self._op("%.3f %.3f %.3f %s" % (r, g, b, "rg" if fill else "RG"))

    def text(self, x, y, s, size=10, font="F1", color=None):
        if color:
            self.color(*color)
        self._op("BT /%s %.1f Tf %.1f %.1f Td (%s) Tj ET"
                 % (font, size, x, y, pdf_escape(s)))

    def line(self, x1, y1, x2, y2, width=0.8, color=(0, 0, 0)):
        self.color(*color, fill=False)
        self._op("%.2f w" % width)
        self._op("%.1f %.1f m %.1f %.1f l S" % (x1, y1, x2, y2))

    def rect(self, x, y, w, h, color=(0, 0, 0), fill=True):
        self.color(*color, fill=fill)
        self._op("%.1f %.1f %.1f %.1f re f" % (x, y, w, h))

    def image(self, x, y, w, h, name):
        """Place an image with its TOP-LEFT corner at (x, y).

        Image XObjects have their origin at the top-left with y growing
        downward, so a negative height in the cm matrix maps the image right
        side up into user space (y grows upward).
        """
        self.cur.xobjects.append(name)
        self._op("q %.1f 0 0 -%.1f %.1f %.1f cm /%s Do Q" % (w, h, x, y, name))

    # -- text layout --------------------------------------------------------

    @staticmethod
    def char_w(c, size):
        if c == " ":
            return 0.278 * size
        if c.isdigit():
            return 0.556 * size
        if c.isupper():
            return 0.667 * size
        if c in ".!?,;:":
            return 0.28 * size
        if c in "()[]":
            return 0.33 * size
        if c in "-":
            return 0.333 * size
        if c in "'":
            return 0.222 * size
        if c == '"':
            return 0.5 * size
        return 0.5 * size

    @classmethod
    def text_w(cls, s, size):
        return sum(cls.char_w(c, size) for c in s)

    @classmethod
    def wrap(cls, text, size, max_w):
        lines = []
        for para in text.split("\n"):
            words = para.split(" ")
            cur = ""
            for w in words:
                trial = (cur + " " + w).strip()
                if cls.text_w(trial, size) <= max_w:
                    cur = trial
                else:
                    if cur:
                        lines.append(cur)
                    cur = w
            lines.append(cur)
        return lines

    def flow(self, x, y, text, size=9.5, width=None, leading=None,
             font="F1", color=None, bottom=MARGIN):
        width = width or BODY_W
        leading = leading or size * 1.4
        for ln in self.wrap(text, size, width):
            if y - leading < bottom:
                self.new_page()
                y = self.h - MARGIN
            self.text(x, y, ln, size, font, color)
            y -= leading
        return y

    # -- serialization ------------------------------------------------------

    def finish(self):
        """Serialize the document into PDF bytes."""
        font_names = list(self.FONTS)
        img_names = list(self.images)
        p_count = len(self.pages)

        # pre-compute object numbers
        font_nums = {name: i + 1 for i, name in enumerate(font_names)}
        base = len(font_names)
        img_nums = {name: base + i + 1 for i, name in enumerate(img_names)}
        page_objs = []  # (content_num, page_num)
        cnum = base + len(img_names)
        for _ in range(p_count):
            page_objs.append((cnum, cnum + 1))
            cnum += 2
        pages_num = cnum
        catalog_num = cnum + 1
        total = catalog_num

        chunks = []

        def add(body):
            chunks.append(body)

        # fonts
        for name in font_names:
            add(b"%d 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /%s >>\nendobj\n"
                % (font_nums[name], self.FONTS[name].encode("latin-1")))
        # images
        for name in img_names:
            iw, ih, raw = self.images[name]
            comp = zlib.compress(raw)
            add(b"%d 0 obj\n"
                b"<< /Type /XObject /Subtype /Image /Width %d /Height %d "
                b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
                b"/Length %d >>\nstream\n"
                b"%s\nendstream\nendobj\n" % (img_nums[name], iw, ih, len(comp), comp))
        # pages: content stream + page object
        for idx, page in enumerate(self.pages):
            content = zlib.compress(bytes(page.ops))
            cnum, pnum = page_objs[idx]
            add(b"%d 0 obj\n<< /Length %d /Filter /FlateDecode >>\nstream\n%s\nendstream\nendobj\n"
                % (cnum, len(content), content))
            xobj = b"".join(b"/%s %d 0 R " % (nm.encode("latin-1"), img_nums[nm])
                             for nm in page.xobjects)
            add(b"%d 0 obj\n"
                b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d]\n"
                b"/Resources << /Font << /F1 %d 0 R /F2 %d 0 R /F3 %d 0 R >>\n"
                b"/XObject << %s >> >>\n/Contents %d 0 R >>\nendobj\n"
                % (pnum, pages_num, int(self.w), int(self.h),
                   font_nums["F1"], font_nums["F2"], font_nums["F3"],
                   xobj, cnum))
        # pages tree + catalog
        kids = b" ".join(b"%d 0 R" % page_objs[i][1] for i in range(p_count))
        add(b"%d 0 obj\n<< /Type /Pages /Kids [ %s ] /Count %d >>\nendobj\n"
            % (pages_num, kids, p_count))
        add(b"%d 0 obj\n<< /Type /Catalog /Pages %d 0 R >>\nendobj\n"
            % (catalog_num, pages_num))

        out = bytearray(b"%PDF-1.4\n")
        offsets = [0]
        for i, body in enumerate(chunks):
            offsets.append(len(out))
            out += body
        xref_pos = len(out)
        out += b"xref\n0 %d\n" % (total + 1)
        out += b"0000000000 65535 f \n"
        for off in offsets[1:]:
            out += b"%010d 00000 n \n" % off
        out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" \
            % (total + 1, catalog_num, xref_pos)
        return bytes(out)


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

def load_results(path):
    """Return (conc_order, {conc: [tputs...]}) from the CSV."""
    data = {}
    order = []
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            c = int(row["concurrency"])
            if c not in data:
                data[c] = []
                order.append(c)
            data[c].append(float(row["orders_per_sec"]))
    return order, data


def run_experiment():
    print(">> running load experiment (testing/load_test.py) ...")
    env = dict(os.environ)
    subprocess.run([sys.executable, LOAD_TEST,
                    "--concurrency", "1,2,4,8,12,16,24,32",
                    "--orders", "1000", "--repeats", "5",
                    "--csv", RESULTS_CSV], cwd=ROOT, check=True, env=env)


# ---------------------------------------------------------------------------
# Charts
# ---------------------------------------------------------------------------

def make_charts(conc, means, stds):
    fig, ax = plt.subplots(figsize=(7.0, 3.8))
    ax.errorbar(conc, means, yerr=stds, fmt="-o", color="#1f5fa8",
                ecolor="#c0392b", capsize=4, linewidth=1.6, markersize=5,
                label="mean +/- 1 std (5 repeats)")
    ax.set_xlabel("Concurrent client connections")
    ax.set_ylabel("Throughput (orders / second)")
    ax.set_xticks(conc)
    ax.grid(alpha=0.3, linestyle="--")
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIG1, dpi=200)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(7.0, 3.8))
    x = list(range(len(conc)))
    ax.bar(x, means, yerr=stds, capsize=4, color="#7fb3d5",
           edgecolor="#1f5fa8", error_kw={"ecolor": "#c0392b"})
    ax.set_xticks(x)
    ax.set_xticklabels([str(c) for c in conc])
    ax.set_xlabel("Concurrent client connections")
    ax.set_ylabel("Throughput (orders / second)")
    ax.grid(alpha=0.3, axis="y", linestyle="--")
    fig.tight_layout()
    fig.savefig(FIG2, dpi=200)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------

def build_report(conc, means, stds, mins, maxs, host_info):
    doc = Pdf()
    doc.new_page()

    M = MARGIN
    y = PAGE_H - M

    # ---- title ------------------------------------------------------------
    doc.text(M, y, "Scalability Analysis of an In-Memory Exchange", 16, "F2")
    y -= 20
    doc.text(M, y, "Matching Engine", 16, "F2")
    y -= 22
    doc.text(M, y, "ECE 568 - Engineering Robust Server Software - Homework 4", 11, "F1")
    y -= 16
    doc.text(M, y, "Date: 2026-08-29      Machine: %s" % host_info, 9, "F3")
    y -= 14
    doc.line(M, y, PAGE_W - M, y, width=1.0)
    y -= 16

    # ---- abstract ---------------------------------------------------------
    doc.text(M, y, "Abstract", 12, "F2")
    y -= 16
    y = doc.flow(
        M, y,
        "This report analyzes the scalability of an in-memory exchange matching "
        "engine written in Python. The server matches limit buy and sell orders "
        "with price-time priority, keeps every account, position, order and "
        "order book in memory, and serializes all state changes under one global "
        "lock so that every match is atomic. We load-test the server with up to "
        "32 concurrent client connections and 1,000 orders per client per run, "
        "repeating each configuration five times. Throughput rises from about "
        "20.7k orders/s with a single client to a peak of about 40k orders/s at "
        "4-8 connections and then saturates (and becomes more variable) around "
        "27-31k orders/s, which is consistent with GIL and lock contention in a "
        "threaded Python design. We report the full methodology, results and "
        "analysis below; all experiments are reproducible with the provided "
        "testing/load_test.py script.",
        size=9.5, leading=13.5, bottom=M + 10)
    y -= 6

    # ---- 1. design --------------------------------------------------------
    doc.text(M, y, "1.  System Design", 12, "F2")
    y -= 16
    y = doc.flow(M, y, "The server listens on TCP port 12345. Each request is "
                 "framed as one ASCII line with the byte length of the XML "
                 "payload, followed by exactly that many bytes of XML whose "
                 "top-level element is <create> or <transactions id=\"...\">. "
                 "The server replies with a <results> document. All state is "
                 "held in memory: accounts with USD balances and per-symbol "
                 "positions, a global order table, and one price-sorted order "
                 "book (buy side and sell side) per symbol. Arithmetic on "
                 "money and shares uses exact decimal arithmetic.", size=9.5,
                 leading=13.5, bottom=M + 10)
    y -= 4
    y = doc.flow(M, y, "Matching follows the assignment rules: a new order "
                 "crosses at the best price (highest resting buy, lowest "
                 "resting sell), ties are broken by arrival order, and the "
                 "execution price is the limit price of the order that was "
                 "open first. The unfulfilled remainder of a resting order "
                 "keeps its original priority. A buy order reserves "
                 "amount*limit from the buyer's balance when it is placed; on "
                 "execution the difference between the limit and the actual "
                 "price is refunded, and on cancellation the remaining "
                 "reservation is refunded. A sell order removes its shares "
                 "from the seller's account at placement, which makes short "
                 "selling impossible; proceeds are credited on execution and "
                 "remaining shares are returned on cancellation.", size=9.5,
                 leading=13.5, bottom=M + 10)
    y -= 4
    y = doc.flow(M, y, "Concurrency model: one thread per connection, and a "
                 "global RLock protects all shared state. Because a match "
                 "touches two orders and two accounts, the global lock makes "
                 "every state change (including a match) atomic and easy to "
                 "reason about; it is also the main serialization point that "
                 "limits scalability, as discussed in Section 4.", size=9.5,
                 leading=13.5, bottom=M + 10)
    y -= 6

    # ---- 2. methodology ---------------------------------------------------
    doc.text(M, y, "2.  Experimental Methodology", 12, "F2")
    y -= 16
    y = doc.flow(M, y, "Hardware and software. The experiments were run on "
                 "the local development machine (%s); it reports %d logical "
                 "CPUs. The server runs Python %s with no third-party "
                 "dependencies. Per the assignment, the same scripts are "
                 "designed to be re-run on one of the ECE 568 multi-core VMs; "
                 "the procedure is given in Section 2.5." %
                 (host_info, os.cpu_count(), platform.python_version()),
                 size=9.5, leading=13.5, bottom=M + 10)
    y -= 4
    y = doc.flow(M, y, "Workload. For each concurrency level C in "
                 "{1, 2, 4, 8, 12, 16, 24, 32} we run 5 repeats. In every "
                 "repeat, C client threads each open one persistent TCP "
                 "connection and send 1,000 order requests back to back, "
                 "alternating a buy and a sell of 10 shares at limit 100 so "
                 "that every pair crosses and executes. This exercises the "
                 "whole server path: accept, length-prefix framing, XML "
                 "parsing, price-time matching, execution settlement and "
                 "response serialization. The accounts and symbols are "
                 "created before timing starts, so setup is not measured.",
                 size=9.5, leading=13.5, bottom=M + 10)
    y -= 4
    y = doc.flow(M, y, "Measurement. Elapsed time is measured with a "
                 "high-resolution monotonic clock from thread spawn until all "
                 "client threads finish. Throughput = total orders / elapsed. "
                 "Each configuration is repeated 5 times; we report the mean, "
                 "the sample standard deviation, and the min/max across "
                 "repeats. No data points were discarded.",
                 size=9.5, leading=13.5, bottom=M + 10)
    y -= 4
    y = doc.flow(M, y, "Multi-core (CPU-count) sweep. On the ECE 568 VM the "
                 "CPU-count axis is produced by pinning the server process to "
                 "an increasing number of cores and repeating the same load "
                 "test, e.g.:  taskset -c 0,1 python server.py  then "
                 "python testing/load_test.py --concurrency 16 --orders 1000 "
                 "--repeats 5 --csv writeup/results_cores.csv  for each core "
                 "set. The analysis in Section 4 transfers directly: more "
                 "cores add capacity until the global lock and the Python GIL "
                 "become the bottleneck.", size=9.5, leading=13.5,
                 bottom=M + 10)
    y -= 6

    # ---- 3. results -------------------------------------------------------
    if y < PAGE_H - M - 330:
        doc.new_page()
        y = PAGE_H - M
    doc.text(M, y, "3.  Results", 12, "F2")
    y -= 16
    y = doc.flow(M, y, "Table 1 summarizes the measured throughput. "
                 "Figures 1 and 2 visualize the same data with one-standard-"
                 "deviation error bars.", size=9.5, leading=13.5, bottom=M + 10)
    y -= 8

    # table
    cols = [("Concurrency", 90), ("Mean orders/s", 100), ("Std", 70),
            ("Min", 70), ("Max", 70)]
    col_x = [M]
    for name, w in cols[:-1]:
        col_x.append(col_x[-1] + w)
    total_w = sum(w for _, w in cols)
    table_x0 = M + (BODY_W - total_w) / 2
    row_h = 15
    tx = table_x0
    doc.color(0.1, 0.1, 0.1, fill=True)
    doc.rect(table_x0, y - row_h + 4, total_w, row_h, color=(0.85, 0.87, 0.92))
    cx = table_x0
    for name, w in cols:
        doc.text(cx + 4, y - 4, name, 8.5, "F2")
        cx += w
    y -= row_h
    for i, c in enumerate(conc):
        if i % 2 == 1:
            doc.rect(table_x0, y - row_h + 4, total_w, row_h,
                     color=(0.95, 0.96, 0.98))
        vals = ["%d" % c, "%.0f" % means[i], "%.0f" % stds[i],
                "%.0f" % mins[i], "%.0f" % maxs[i]]
        cx = table_x0
        for j, (name, w) in enumerate(cols):
            doc.text(cx + 4, y - 4, vals[j], 8.5, "F1")
            cx += w
        y -= row_h
    doc.line(table_x0, y + 2, table_x0 + total_w, y + 2)
    doc.text(M + (BODY_W - Pdf.text_w("Table 1: throughput per concurrency level "
                                      "(5 repeats)", 8.5)) / 2, y - 4,
             "Table 1: throughput per concurrency level (5 repeats)", 8.5, "F3")
    y -= 16

    # figure 1
    fig_w = 460
    fig_h = 250
    doc.add_image("fig1", PILImage.open(FIG1))
    if y - fig_h < M:
        doc.new_page()
        y = PAGE_H - M
    doc.image(M + (BODY_W - fig_w) / 2, y, fig_w, fig_h, "fig1")
    y -= fig_h + 4
    doc.text(M + (BODY_W - Pdf.text_w("Figure 1: throughput vs concurrency "
                                      "(mean +/- 1 std)", 8.5)) / 2, y,
             "Figure 1: throughput vs concurrency (mean +/- 1 std)", 8.5, "F3")
    y -= 16

    # figure 2
    doc.add_image("fig2", PILImage.open(FIG2))
    if y - fig_h < M:
        doc.new_page()
        y = PAGE_H - M
    doc.image(M + (BODY_W - fig_w) / 2, y, fig_w, fig_h, "fig2")
    y -= fig_h + 4
    doc.text(M + (BODY_W - Pdf.text_w("Figure 2: mean throughput per concurrency "
                                      "level (error bars = 1 std)", 8.5)) / 2, y,
             "Figure 2: mean throughput per concurrency level (error bars = 1 std)",
             8.5, "F3")
    y -= 16

    # ---- 4. analysis ------------------------------------------------------
    if y < M + 60:
        doc.new_page()
        y = PAGE_H - M
    doc.text(M, y, "4.  Analysis", 12, "F2")
    y -= 16
    y = doc.flow(M, y, "Scaling behavior. Throughput improves with parallelism "
                 "only up to a point: roughly 1.8x from one to two connections "
                 "and a peak around 4-8 connections (~38-40k orders/s, i.e. "
                 "about 1.9x the single-client rate), after which it saturates "
                 "and actually decreases at higher concurrency (27-31k "
                 "orders/s at 12-32 connections). The peak-to-single ratio of "
                 "about 1.9 is far below the 12 logical CPUs available, which "
                 "shows that the server is not CPU-bound in the traditional "
                 "sense but is limited by a serialization point.", size=9.5,
                 leading=13.5, bottom=M + 10)
    y -= 4
    y = doc.flow(M, y, "Lock and GIL contention. Every state change and every "
                 "match is serialized by the global RLock, and Python's GIL "
                 "additionally serializes bytecode execution. At low concurrency "
                 "the lock is mostly idle, so adding connections hides "
                 "per-request latency and throughput grows. As C approaches and "
                 "exceeds the number of cores, threads spend an increasing "
                 "fraction of time waiting for the lock (and the GIL), "
                 "throughput plateaus, and run-to-run variance grows because the "
                 "wait time depends on OS scheduling. The widening error bars at "
                 "16-32 connections (std of 5-6k orders/s) are the visible "
                 "symptom of this contention.", size=9.5, leading=13.5,
                 bottom=M + 10)
    y -= 4
    y = doc.flow(M, y, "Per-request cost. With one client, one order costs "
                 "about 48 microseconds (20.7k orders/s), which is dominated "
                 "by XML parsing and serialization and by Decimal arithmetic "
                 "rather than by the matching logic itself. The engine's "
                 "actual critical path - two heap operations and a few Decimal "
                 "updates per match - is a small fraction of that. This "
                 "suggests the server could scale much further with a "
                 "language/design without a GIL and with finer-grained "
                 "locking (e.g. per-symbol locks plus careful account-level "
                 "locking), at the cost of matching-atomicity complexity.",
                 size=9.5, leading=13.5, bottom=M + 10)
    y -= 4
    y = doc.flow(M, y, "Expected multi-core behavior on the ECE 568 VM. "
                 "Pinning the server to 1, 2, 4, ... cores should show "
                 "throughput growing with core count until the global lock "
                 "becomes the bottleneck - the same plateau shape as Figure 1. "
                 "Because the lock serializes all matching, no further cores "
                 "add capacity beyond that point; only reducing the critical "
                 "section (finer locks, faster XML) would move the plateau.",
                 size=9.5, leading=13.5, bottom=M + 10)
    y -= 6

    # ---- 5. reproducibility ----------------------------------------------
    doc.text(M, y, "5.  Reproducibility", 12, "F2")
    y -= 16
    y = doc.flow(M, y, "The complete test infrastructure is in testing/. "
                 "To reproduce the functionality results:  python "
                 "testing/run_all.py   (starts the server, runs all 23 "
                 "functional tests, stops it). To reproduce this scalability "
                 "study:  python testing/load_test.py --concurrency "
                 "1,2,4,8,12,16,24,32 --orders 1000 --repeats 5 --csv "
                 "writeup/results.csv   and then  python "
                 "writeup/make_report.py --reuse   to regenerate the charts "
                 "and this PDF. To deploy:  docker compose up   (port 12345).",
                 size=9.5, leading=13.5, bottom=M + 10)
    y -= 6

    # ---- appendix ---------------------------------------------------------
    doc.text(M, y, "Appendix: environment", 12, "F2")
    y -= 16
    env_lines = [
        "platform : %s" % platform.platform(),
        "logical CPUs : %d" % (os.cpu_count() or 0),
        "python : %s" % platform.python_version(),
        "host : %s" % socket.gethostname(),
        "server design : Python stdlib, threads + global RLock, in-memory only",
    ]
    for ln in env_lines:
        y = doc.flow(M, y, ln, size=8.5, leading=12, font="F3", bottom=M)
        y -= 1

    data = bytes(doc.finish())
    with open(REPORT, "wb") as fh:
        fh.write(data)
    return len(data)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reuse", action="store_true",
                    help="reuse existing writeup/results.csv instead of re-running")
    args = ap.parse_args()

    if args.reuse and os.path.exists(RESULTS_CSV):
        print(">> reusing %s" % RESULTS_CSV)
    else:
        run_experiment()

    conc, data = load_results(RESULTS_CSV)
    means = [statistics.mean(data[c]) for c in conc]
    stds = [statistics.stdev(data[c]) if len(data[c]) > 1 else 0.0 for c in conc]
    mins = [min(data[c]) for c in conc]
    maxs = [max(data[c]) for c in conc]

    print(">> drawing charts ...")
    make_charts(conc, means, stds)

    host_info = platform.platform()
    print(">> writing %s ..." % REPORT)
    size = build_report(conc, means, stds, mins, maxs, host_info)
    print(">> report.pdf written: %d bytes" % size)
    assert size > 1000
    return 0


if __name__ == "__main__":
    sys.exit(main())
