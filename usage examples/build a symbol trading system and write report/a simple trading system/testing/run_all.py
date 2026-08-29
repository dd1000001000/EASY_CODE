#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Run the whole functional test suite against the exchange server.

The server (../server.py) is started automatically unless port 12345 is
already serving a server, in which case that one is used.  Any server that
this script started is terminated before the script exits.

Usage:
    python run_all.py
"""

import os
import socket
import subprocess
import sys
import time
import unittest

HOST, PORT = "127.0.0.1", 12345
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")


def port_open(host=HOST, port=PORT):
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def main():
    proc = None
    started = False
    if not port_open():
        print("[run_all] starting server: %s" % SERVER)
        proc = subprocess.Popen([sys.executable, SERVER], cwd=ROOT)
        started = True
        deadline = time.time() + 20.0
        while time.time() < deadline:
            if port_open():
                break
            time.sleep(0.1)
        else:
            print("FATAL: server did not start on port %d" % PORT, file=sys.stderr)
            proc.kill()
            return 1
    else:
        print("[run_all] using already-running server on port %d" % PORT)

    try:
        suite = unittest.defaultTestLoader.discover(HERE, pattern="functional_test.py")
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        ok = result.wasSuccessful()
        print()
        print("=" * 60)
        print("ALL FUNCTIONAL TESTS PASSED" if ok else "SOME FUNCTIONAL TESTS FAILED")
        print("=" * 60)
        return 0 if ok else 1
    finally:
        if started and proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            print("[run_all] server stopped")


if __name__ == "__main__":
    sys.exit(main())
