#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Exchange matching engine server.

Homework 4 -- Scalability: Exchange Matching (Engineering Robust Server Software).

Protocol (TCP port 12345):
  * One line containing a base-10 unsigned integer N (the byte length of the
    XML payload that follows), then immediately after the newline, exactly N
    bytes of XML.
  * The top-level XML element is either <create> or <transactions id="...">.
  * The server replies with an XML document whose root is <results>.

All state -- accounts, positions, orders and order books -- is kept in
memory only (no files, no database, no persistence).

Matching rules:
  * Best price first; ties are broken by arrival order (price-time priority).
  * The execution price of a match is the limit price of the order that was
    resting (open first) on the book.
  * A buy order is funded when it is placed (amount * limit is reserved from
    the buyer's balance).  When it executes, the difference between the
    reserved limit price and the actual execution price is refunded.  A
    canceled buy order gets its remaining reservation refunded.
  * A sell order has its shares removed from the seller's account when it is
    placed; the proceeds are credited on execution, and a canceled sell order
    gets its remaining shares back.  Short selling is therefore impossible.
  * Every state mutation (including a match, which touches both legs and both
    accounts) happens under a single global lock, so matching is atomic.

Concurrency model: one thread per connection + a global RLock protecting all
shared state.  This keeps every operation atomic and easy to reason about.
"""

import heapq
import socket
import threading
import time
from decimal import Decimal, InvalidOperation
import xml.etree.ElementTree as ET

HOST = "0.0.0.0"
PORT = 12345

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def fmt(value):
    """Format a Decimal without trailing zeros (no exponent notation)."""
    s = format(value, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def localname(tag):
    """Strip any XML namespace prefix from an element tag."""
    return tag.rsplit("}", 1)[-1]


def esc_attr(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def esc_text(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class El:
    """Tiny XML builder used to produce the exact response shape we need."""

    __slots__ = ("tag", "attrs", "text", "children")

    def __init__(self, tag, attrs=None, text=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.text = text
        self.children = []

    def add(self, child):
        self.children.append(child)
        return child

    def to_xml(self):
        parts = ["<", self.tag]
        for k, v in self.attrs.items():
            parts.append(' %s="%s"' % (k, esc_attr(v)))
        if self.text is None and not self.children:
            parts.append("/>")
            return "".join(parts)
        parts.append(">")
        if self.text is not None:
            parts.append(esc_text(self.text))
        for c in self.children:
            parts.append(c.to_xml())
        parts.append("</%s>" % self.tag)
        return "".join(parts)


# ---------------------------------------------------------------------------
# Core state
# ---------------------------------------------------------------------------


class Order:
    __slots__ = (
        "oid",
        "acct",
        "sym",
        "amount",      # signed: >0 buy, <0 sell
        "limit",
        "remaining",   # positive remaining quantity to trade
        "seq",         # arrival sequence number (also the order id)
        "status",      # 'open' | 'closed' (fully executed) | 'canceled'
        "executions",  # list of (shares, price, ts)
        "canceled",    # None or (shares, ts)
    )

    def __init__(self, oid, acct, sym, amount, limit):
        self.oid = oid
        self.acct = acct
        self.sym = sym
        self.amount = amount
        self.limit = limit
        self.remaining = abs(amount)
        self.seq = oid
        self.status = "open"
        self.executions = []
        self.canceled = None


class Exchange:
    """In-memory exchange: accounts, positions, orders and order books.

    All methods take the global lock, so a whole request (create or
    transactions) is processed atomically.
    """

    def __init__(self):
        self.lock = threading.RLock()
        self.accounts = {}     # acct_id -> {"balance": Decimal, "positions": {sym: Decimal}}
        self.symbols = set()   # symbols that were created
        self.orders = {}       # oid -> Order
        self.books = {}        # sym -> {"buy": [(key, Order)], "sell": [(key, Order)]}
        self.next_oid = 1

    # -- helpers ------------------------------------------------------------

    def _book(self, sym):
        b = self.books.get(sym)
        if b is None:
            b = {"buy": [], "sell": []}
            self.books[sym] = b
        return b

    @staticmethod
    def _invalid(order):
        return order.status != "open" or order.remaining <= 0

    def _new_oid(self):
        oid = self.next_oid
        self.next_oid += 1
        return oid

    # -- create -------------------------------------------------------------

    def create_account(self, acct_id, balance):
        with self.lock:
            if acct_id in self.accounts:
                return "error", "Account already exists"
            self.accounts[acct_id] = {"balance": balance, "positions": {}}
            return "created", None

    def add_symbol_shares(self, sym, acct_id, shares):
        with self.lock:
            self.symbols.add(sym)
            acct = self.accounts.get(acct_id)
            if acct is None:
                return "error", "Account does not exist"
            positions = acct["positions"]
            positions[sym] = positions.get(sym, Decimal(0)) + shares
            return "created", None

    # -- orders -------------------------------------------------------------

    def place_order(self, acct_id, sym, amount, limit):
        """Place an order and immediately try to match it.

        Returns ("opened", oid) or ("error", message).
        """
        with self.lock:
            acct = self.accounts.get(acct_id)
            if acct is None:
                return "error", "Invalid account"

            if amount > 0:
                cost = amount * limit
                if acct["balance"] < cost:
                    return "error", "Insufficient funds"
                acct["balance"] -= cost
            else:
                shares = -amount
                positions = acct["positions"]
                have = positions.get(sym, Decimal(0))
                if have < shares:
                    return "error", "Insufficient shares"
                positions[sym] = have - shares

            oid = self._new_oid()
            order = Order(oid, acct_id, sym, amount, limit)
            self.orders[oid] = order

            self._match(order)

            if order.remaining > 0 and order.status == "open":
                book = self._book(sym)
                if amount > 0:
                    heapq.heappush(book["buy"], ((-limit, oid), order))
                else:
                    heapq.heappush(book["sell"], ((limit, oid), order))

            return "opened", oid

    def _match(self, order):
        """Match an incoming order against the resting book.

        The incoming order always crosses at the price of the resting order
        (the one that was open first).  If the resting order is only partially
        consumed it keeps its heap key, so its priority is unchanged.
        """
        book = self._book(order.sym)
        if order.amount > 0:
            # Aggressive buy: consume the cheapest resting sells.
            while order.remaining > 0:
                sell_book = book["sell"]
                while sell_book and self._invalid(sell_book[0][1]):
                    heapq.heappop(sell_book)
                if not sell_book:
                    break
                rest = sell_book[0][1]
                if rest.limit > order.limit:
                    break
                matched = min(order.remaining, rest.remaining)
                price = rest.limit
                ts = int(time.time())
                order.remaining -= matched
                rest.remaining -= matched
                order.executions.append((matched, price, ts))
                rest.executions.append((matched, price, ts))
                buyer = self.accounts[order.acct]
                seller = self.accounts[rest.acct]
                buyer["balance"] += (order.limit - price) * matched
                buyer["positions"][order.sym] = (
                    buyer["positions"].get(order.sym, Decimal(0)) + matched
                )
                seller["balance"] += price * matched
                if rest.remaining == 0:
                    heapq.heappop(sell_book)
                    rest.status = "closed"
                if order.remaining == 0:
                    order.status = "closed"
                    break
        else:
            # Aggressive sell: consume the most expensive resting buys.
            while order.remaining > 0:
                buy_book = book["buy"]
                while buy_book and self._invalid(buy_book[0][1]):
                    heapq.heappop(buy_book)
                if not buy_book:
                    break
                rest = buy_book[0][1]
                if rest.limit < order.limit:
                    break
                matched = min(order.remaining, rest.remaining)
                price = rest.limit
                ts = int(time.time())
                order.remaining -= matched
                rest.remaining -= matched
                order.executions.append((matched, price, ts))
                rest.executions.append((matched, price, ts))
                buyer = self.accounts[rest.acct]
                seller = self.accounts[order.acct]
                buyer["balance"] += (rest.limit - price) * matched
                buyer["positions"][order.sym] = (
                    buyer["positions"].get(order.sym, Decimal(0)) + matched
                )
                seller["balance"] += price * matched
                if rest.remaining == 0:
                    heapq.heappop(buy_book)
                    rest.status = "closed"
                if order.remaining == 0:
                    order.status = "closed"
                    break

    def query_order(self, acct_id, oid):
        with self.lock:
            if acct_id not in self.accounts:
                return "error", "Invalid account"
            order = self.orders.get(oid)
            if order is None:
                return "error", "Invalid transaction id"
            return "status", order

    def cancel_order(self, acct_id, oid):
        with self.lock:
            if acct_id not in self.accounts:
                return "error", "Invalid account"
            order = self.orders.get(oid)
            if order is None:
                return "error", "Invalid transaction id"
            if order.status == "canceled":
                return "error", "Order already canceled"
            if order.status == "open" and order.remaining > 0:
                ts = int(time.time())
                order.canceled = (order.remaining, ts)
                order.status = "canceled"
                acct = self.accounts[order.acct]
                if order.amount > 0:
                    acct["balance"] += order.remaining * order.limit
                else:
                    positions = acct["positions"]
                    positions[order.sym] = (
                        positions.get(order.sym, Decimal(0)) + order.remaining
                    )
            # A fully executed order has no open portion; the cancellation is
            # a harmless no-op and we report its executed history.
            return "canceled", order


# ---------------------------------------------------------------------------
# Request processing (XML <-> state)
# ---------------------------------------------------------------------------


def _status_el(order):
    el = El("status", {"id": order.oid})
    if order.status == "open" and order.remaining > 0:
        el.add(El("open", {"shares": fmt(order.remaining)}))
    for shares, price, ts in order.executions:
        el.add(El("executed", {"shares": fmt(shares), "price": fmt(price), "time": ts}))
    if order.canceled is not None:
        el.add(El("canceled", {"shares": fmt(order.canceled[0]), "time": order.canceled[1]}))
    return el


def _canceled_el(order):
    el = El("canceled", {"id": order.oid})
    if order.canceled is not None:
        el.add(El("canceled", {"shares": fmt(order.canceled[0]), "time": order.canceled[1]}))
    for shares, price, ts in order.executions:
        el.add(El("executed", {"shares": fmt(shares), "price": fmt(price), "time": ts}))
    return el


def _process_create(root, exchange):
    results = El("results")
    for child in root:
        tag = localname(child.tag)
        if tag == "account":
            acct_id = child.get("id")
            bal_raw = child.get("balance")
            try:
                balance = Decimal(bal_raw)
            except (InvalidOperation, TypeError):
                results.add(El("error", {"id": acct_id}, "Invalid balance"))
                continue
            kind, msg = exchange.create_account(acct_id, balance)
            if kind == "created":
                results.add(El("created", {"id": acct_id}))
            else:
                results.add(El("error", {"id": acct_id}, msg))
        elif tag == "symbol":
            sym = child.get("sym")
            for acc in child:
                if localname(acc.tag) != "account":
                    continue
                aid = acc.get("id")
                raw = acc.text.strip() if acc.text is not None else "0"
                try:
                    shares = Decimal(raw)
                except (InvalidOperation, TypeError):
                    results.add(El("error", {"sym": sym, "id": aid}, "Invalid share amount"))
                    continue
                kind, msg = exchange.add_symbol_shares(sym, aid, shares)
                if kind == "created":
                    results.add(El("created", {"sym": sym, "id": aid}))
                else:
                    results.add(El("error", {"sym": sym, "id": aid}, msg))
        # Unknown children of <create> are ignored.
    return results.to_xml()


def _process_transactions(root, exchange):
    results = El("results")
    acct_id = root.get("id")
    for child in root:
        tag = localname(child.tag)
        if tag == "order":
            sym = child.get("sym")
            amt_raw = child.get("amount")
            lim_raw = child.get("limit")
            try:
                amount = Decimal(amt_raw)
                limit = Decimal(lim_raw)
            except (InvalidOperation, TypeError):
                results.add(
                    El("error", {"sym": sym, "amount": amt_raw, "limit": lim_raw},
                       "Invalid amount or limit")
                )
                continue
            kind, detail = exchange.place_order(acct_id, sym, amount, limit)
            if kind == "opened":
                results.add(El("opened", {"sym": sym, "amount": amt_raw, "limit": lim_raw,
                                          "id": detail}))
            else:
                results.add(El("error", {"sym": sym, "amount": amt_raw, "limit": lim_raw},
                               detail))
        elif tag == "query":
            oid_raw = child.get("id")
            try:
                oid = int(oid_raw)
            except (TypeError, ValueError):
                results.add(El("error", {"id": oid_raw}, "Invalid transaction id"))
                continue
            kind, detail = exchange.query_order(acct_id, oid)
            if kind == "status":
                results.add(_status_el(detail))
            else:
                results.add(El("error", {"id": oid_raw}, detail))
        elif tag == "cancel":
            oid_raw = child.get("id")
            try:
                oid = int(oid_raw)
            except (TypeError, ValueError):
                results.add(El("error", {"id": oid_raw}, "Invalid transaction id"))
                continue
            kind, detail = exchange.cancel_order(acct_id, oid)
            if kind == "canceled":
                results.add(_canceled_el(detail))
            else:
                results.add(El("error", {"id": oid}, detail))
        # Unknown children of <transactions> are ignored.
    return results.to_xml()


def process_request(data, exchange):
    """Parse one request's XML bytes and return the response XML string."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        r = El("results")
        r.add(El("error", {"id": "0"}, "Malformed XML"))
        return r.to_xml()

    tag = localname(root.tag)
    if tag == "create":
        return _process_create(root, exchange)
    if tag == "transactions":
        return _process_transactions(root, exchange)

    r = El("results")
    r.add(El("error", {}, "Unknown top-level element: %s" % root.tag))
    return r.to_xml()


# ---------------------------------------------------------------------------
# Network layer
# ---------------------------------------------------------------------------


def handle_connection(conn, exchange):
    with conn:
        try:
            reader = conn.makefile("rb")
        except OSError:
            return
        try:
            while True:
                line = reader.readline()
                if not line:
                    return
                try:
                    n = int(line.strip())
                except ValueError:
                    return
                data = b""
                while len(data) < n:
                    chunk = reader.read(n - len(data))
                    if not chunk:
                        return
                    data += chunk
                if len(data) != n:
                    return
                resp = process_request(data, exchange)
                conn.sendall(resp.encode("utf-8"))
        except (OSError, ValueError):
            return


def main():
    exchange = Exchange()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(128)
    print("Exchange server listening on %s:%d (in-memory state)" % (HOST, PORT), flush=True)
    while True:
        conn, _addr = srv.accept()
        t = threading.Thread(target=handle_connection, args=(conn, exchange), daemon=True)
        t.start()


if __name__ == "__main__":
    main()
