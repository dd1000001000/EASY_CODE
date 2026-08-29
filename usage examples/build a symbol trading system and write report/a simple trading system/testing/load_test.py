#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Concurrency throughput benchmark for the exchange server (scalability test).

Methodology
-----------
For each concurrency level C (default 1, 2, 4, 8, 16, 32):

  * setup: one fresh (buyer, seller, symbol) triple is created per client
    thread (this setup is not included in the measured time);
  * R repeat runs: in each run, C threads open one persistent TCP connection
    each and send K order requests back-to-back, alternating a buy and a sell
    at the same limit price so every order pair crosses and executes;
  * throughput = (C * K orders) / elapsed wall-clock seconds, where elapsed
    is measured from thread spawn until all threads have finished.

The workload exercises the complete server path: connection accept,
length-prefix framing, XML parsing, price-time priority matching, execution
settlement (balance/position updates) and XML response serialization.

Usage
-----
    python testing/load_test.py [--concurrency 1,2,4,8,16,32]
                                [--orders 200] [--repeats 3]
                                [--csv writeup/results.csv] [--no-start]
                                [--host 127.0.0.1] [--port 12345]

If the server is not already listening on the port it is started
automatically (and stopped afterwards) unless --no-start is given.

Output: a printed table and (with --csv) one CSV row per repeat:
    concurrency, repeat, total_orders, elapsed_s, orders_per_sec
"""

import argparse
import csv
import os
import platform
import socket
import statistics
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from client import (  # noqa: E402
    HOST, PORT,
    send, send_multi,
    create, acct, symbol, holder, transactions, order,
)

ORD_QTY = "10"     # shares per order
PRICE = "100"      # limit price (identical for buy and sell so they cross)
BUYER_BALANCE = "1000000000"
SELLER_SHARES = "1000000"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server.py")


def port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def parse_csv_arg(s):
    return [int(x) for x in s.split(",") if x.strip()]


def run_worker(buyer, seller, sym, k, host, port, out, idx):
    """Send K alternating buy/sell orders over one persistent connection."""
    reqs = []
    for i in range(k):
        if i % 2 == 0:
            reqs.append(transactions(buyer, order(sym, ORD_QTY, PRICE)))
        else:
            reqs.append(transactions(seller, order(sym, "-%s" % ORD_QTY, PRICE)))
    try:
        roots = send_multi(reqs, host=host, port=port, timeout=120)
        opened = sum(1 for r in roots if r[0].tag.rsplit("}", 1)[-1] == "opened")
        out[idx] = opened
    except Exception:
        out[idx] = -1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--concurrency", default="1,2,4,8,16,32",
                    help="comma-separated concurrency levels")
    ap.add_argument("--orders", type=int, default=200,
                    help="orders per client per repeat")
    ap.add_argument("--repeats", type=int, default=3,
                    help="repeat runs per concurrency level")
    ap.add_argument("--csv", default=None, help="write results CSV here")
    ap.add_argument("--no-start", action="store_true",
                    help="do not auto-start the server")
    args = ap.parse_args()

    levels = parse_csv_arg(args.concurrency)
    if not levels:
        print("error: no concurrency levels", file=sys.stderr)
        return 2

    print("machine: %s, %d logical CPUs" % (platform.platform(), os.cpu_count()))
    print("server:  %s:%d" % (args.host, args.port))
    print("levels:  %s, orders/client=%d, repeats=%d"
          % (levels, args.orders, args.repeats))

    # ---- start server if needed -----------------------------------------
    proc = None
    started = False
    if not port_open(args.host, args.port):
        if args.no_start:
            print("error: no server on %s:%d and --no-start given"
                  % (args.host, args.port), file=sys.stderr)
            return 2
        print("starting server: %s" % SERVER)
        proc = subprocess.Popen([sys.executable, SERVER], cwd=ROOT)
        started = True
        deadline = time.time() + 20.0
        while time.time() < deadline:
            if port_open(args.host, args.port):
                break
            time.sleep(0.1)
        else:
            print("FATAL: server did not start", file=sys.stderr)
            proc.kill()
            return 1

    rows = []
    try:
        for c in levels:
            print("\n== concurrency %d ==" % c, flush=True)
            for rep in range(1, args.repeats + 1):
                # ---- setup (not measured) --------------------------------
                for i in range(c):
                    sym = "L%d%d%d" % (c, rep, i)
                    buyer = "B%d%d%d" % (c, rep, i)
                    seller = "S%d%d%d" % (c, rep, i)
                    send(create(
                        acct(buyer, BUYER_BALANCE),
                        acct(seller, "0"),
                        symbol(sym, holder(seller, SELLER_SHARES)),
                    ), host=args.host, port=args.port)

                # ---- measured run -----------------------------------------
                out = [-1] * c
                threads = [
                    threading.Thread(
                        target=run_worker,
                        args=("B%d%d%d" % (c, rep, i), "S%d%d%d" % (c, rep, i),
                              "L%d%d%d" % (c, rep, i), args.orders,
                              args.host, args.port, out, i),
                        daemon=True,
                    )
                    for i in range(c)
                ]
                start = time.perf_counter()
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()
                elapsed = time.perf_counter() - start

                total = sum(out)
                ok = total == c * args.orders
                tput = total / elapsed if elapsed > 0 else 0.0
                rows.append((c, rep, total, elapsed, tput))
                print("  repeat %d: %d orders in %.3fs -> %.1f orders/s%s"
                      % (rep, total, elapsed, tput,
                         "" if ok else "  [WARNING: %d missing]" % (c * args.orders - total)),
                      flush=True)

        # ---- summary table ------------------------------------------------
        print("\n=== summary ===")
        print("%-6s %-14s %-14s %-10s" % ("conc", "mean orders/s", "std", "runs"))
        for c in levels:
            tputs = [r[4] for r in rows if r[0] == c]
            mean = statistics.mean(tputs)
            std = statistics.stdev(tputs) if len(tputs) > 1 else 0.0
            print("%-6d %-14.1f %-14.1f %-10d" % (c, mean, std, len(tputs)))

        if args.csv:
            os.makedirs(os.path.dirname(os.path.abspath(args.csv)), exist_ok=True)
            with open(args.csv, "w", newline="", encoding="utf-8") as fh:
                w = csv.writer(fh)
                w.writerow(["concurrency", "repeat", "total_orders",
                            "elapsed_s", "orders_per_sec"])
                w.writerows(rows)
            print("\nresults written to %s" % args.csv)
        return 0
    finally:
        if started and proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            print("server stopped")


if __name__ == "__main__":
    sys.exit(main())
