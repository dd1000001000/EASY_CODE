#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Black-box functional tests for the exchange matching server.

Coverage (per the README specification):
  * README create + matching examples (exact expected responses)
  * insufficient-funds rejection for buy orders
  * short-sale (insufficient shares) rejection for sell orders
  * cancel refunds money (buy) / returns shares (sell)
  * partial execution, partial execution then cancel
  * price priority and time priority (arrival order) matching
  * invalid account / duplicate account / invalid transaction id
  * symbol creation errors and create-children processing order
  * symbol creation adding more shares to an existing account
  * atomicity: matched orders update both accounts consistently
  * equal-limit-price crossing
  * fractional balances / amounts / limits (exact decimal arithmetic)
  * several requests over one TCP connection

Run with:
    python run_all.py            # auto start/stop the server
    python functional_test.py    # requires a server already on :12345
"""

import itertools
import socket
import unittest
import xml.etree.ElementTree as ET

from client import (
    HOST, PORT,
    send, send_multi,
    create, acct, symbol, holder, transactions, order, query, cancel,
    kids, child_map,
)

_COUNTER = itertools.count(1)
# Account ids: one global counter so they can never collide across tests
_ACCT = itertools.count(1000001)


def uniq():
    """Unique decimal id (account ids are base-10 digits per the spec)."""
    return str(next(_COUNTER))


def acct_id():
    return str(next(_ACCT))


class ExchangeFunctionalTest(unittest.TestCase):
    """Each test gets its own accounts/symbol, all in one shared server."""

    def setUp(self):
        n = uniq()
        self.buyer = acct_id()
        self.seller = acct_id()
        self.sym = "SYM" + n
        resp = send(create(
            acct(self.buyer, "1000000"),
            acct(self.seller, "0"),
            symbol(self.sym, holder(self.seller, "100000")),
        ))
        for k in kids(resp):
            self.assertEqual(k[0], "created", resp)

    # -- helpers ------------------------------------------------------------

    def buy(self, acct_id, amt, limit, sym=None):
        return send(transactions(acct_id, order(sym or self.sym, amt, limit)))

    def sell(self, acct_id, amt, limit, sym=None):
        return send(transactions(acct_id, order(sym or self.sym, "-%s" % amt, limit)))

    def opened(self, resp):
        ks = kids(resp)
        self.assertEqual(ks[0][0], "opened", ks)
        return int(ks[0][1]["id"])

    def status(self, acct_id, oid):
        r = send(transactions(acct_id, query(oid)))
        self.assertEqual(r[0].tag.rsplit("}", 1)[-1], "status", ET.tostring(r))
        return r[0]

    def cancel_reply(self, acct_id, oid):
        r = send(transactions(acct_id, cancel(oid)))
        self.assertEqual(r[0].tag.rsplit("}", 1)[-1], "canceled", ET.tostring(r))
        return r[0]

    # -- tests --------------------------------------------------------------

    def test_readme_create_example(self):
        req = ('<?xml version="1.0" encoding="UTF-8"?>\n<create>\n'
               '  <account id="123456" balance="1000"/>\n'
               '  <symbol sym="SPY">\n    <account id="123456">100000</account>\n'
               '  </symbol>\n</create>')
        r = send(req)
        self.assertEqual(r.tag, "results")
        ks = kids(r)
        self.assertEqual(ks, [
            ("created", {"id": "123456"}, ""),
            ("created", {"sym": "SPY", "id": "123456"}, ""),
        ])

    def test_readme_matching_example(self):
        # The exact order sequence from the README (ids captured from replies).
        def place(acct_id, body):
            return self.opened(send(transactions(acct_id, body)))

        o1 = place(self.buyer, order(self.sym, "300", "125"))
        o2 = place(self.seller, order(self.sym, "-100", "130"))
        o3 = place(self.buyer, order(self.sym, "200", "127"))
        o4 = place(self.seller, order(self.sym, "-500", "128"))
        o5 = place(self.seller, order(self.sym, "-200", "140"))
        o6 = place(self.buyer, order(self.sym, "400", "125"))
        o7 = place(self.seller, order(self.sym, "-400", "124"))

        # order 1: 100 open, 200 executed at 125
        m = child_map(self.status(self.buyer, o1))
        self.assertEqual(m["open"][0].attrib["shares"], "100")
        self.assertEqual(len(m["executed"]), 1)
        self.assertEqual(m["executed"][0].attrib["shares"], "200")
        self.assertEqual(m["executed"][0].attrib["price"], "125")

        # order 3: fully executed, 200 @ 127
        m = child_map(self.status(self.buyer, o3))
        self.assertNotIn("open", m)
        self.assertEqual(len(m["executed"]), 1)
        self.assertEqual(m["executed"][0].attrib["shares"], "200")
        self.assertEqual(m["executed"][0].attrib["price"], "127")

        # order 7: fully executed in two parts: 200@127 then 200@125
        m = child_map(self.status(self.seller, o7))
        self.assertNotIn("open", m)
        self.assertEqual(len(m["executed"]), 2)
        parts = sorted((e.attrib["shares"], e.attrib["price"]) for e in m["executed"])
        self.assertEqual(parts, [("200", "125"), ("200", "127")])

    def test_insufficient_funds(self):
        aid = acct_id()
        send(create(acct(aid, "100")))
        r = send(transactions(aid, order("SYMX", "200", "1")))
        ks = kids(r)
        self.assertEqual(ks[0][0], "error")
        self.assertEqual(ks[0][1], {"sym": "SYMX", "amount": "200", "limit": "1"})
        self.assertIn("Insufficient", ks[0][2])
        # nothing was deducted: a 100-unit order at 1 still succeeds
        r2 = send(transactions(aid, order("SYMX", "100", "1")))
        self.assertEqual(kids(r2)[0][0], "opened")

    def test_short_sale_rejected(self):
        # selling one more share than owned must be rejected
        r = self.sell(self.seller, "100001", "10")
        ks = kids(r)
        self.assertEqual(ks[0][0], "error")
        self.assertEqual(ks[0][1], {"sym": self.sym, "amount": "-100001", "limit": "10"})
        self.assertIn("Insufficient", ks[0][2])
        # selling exactly what is owned is fine
        r2 = self.sell(self.seller, "100000", "10")
        self.assertEqual(kids(r2)[0][0], "opened")

    def test_cancel_buy_refunds(self):
        oid = self.opened(self.buy(self.buyer, "100", "5"))
        r = self.cancel_reply(self.buyer, oid)
        m = child_map(r)
        self.assertNotIn("open", m)
        self.assertEqual(m["canceled"][0].attrib["shares"], "100")
        self.assertIn("time", m["canceled"][0].attrib)
        # balance was 1,000,000; after 100@5 reserved and refunded it is again
        # 1,000,000, so a 100 @ 9999 order (cost 999,900) must succeed.
        r2 = self.buy(self.buyer, "100", "9999")
        self.assertEqual(kids(r2)[0][0], "opened")

    def test_cancel_sell_returns_shares(self):
        oid = self.opened(self.sell(self.seller, "60", "10"))
        r = self.cancel_reply(self.seller, oid)
        m = child_map(r)
        self.assertEqual(m["canceled"][0].attrib["shares"], "60")
        # the 60 shares are back: selling the full 100,000 now succeeds
        r2 = self.sell(self.seller, "100000", "10")
        self.assertEqual(kids(r2)[0][0], "opened")

    def test_partial_execution(self):
        b = self.opened(self.buy(self.buyer, "300", "125"))
        s = self.opened(self.sell(self.seller, "200", "125"))
        m = child_map(self.status(self.buyer, b))
        self.assertEqual(m["open"][0].attrib["shares"], "100")
        self.assertEqual(len(m["executed"]), 1)
        self.assertEqual(m["executed"][0].attrib["shares"], "200")
        self.assertEqual(m["executed"][0].attrib["price"], "125")
        ms = child_map(self.status(self.seller, s))
        self.assertNotIn("open", ms)
        self.assertEqual(len(ms["executed"]), 1)
        self.assertEqual(ms["executed"][0].attrib["shares"], "200")

    def test_price_priority(self):
        a = self.opened(self.sell(self.seller, "100", "126"))  # resting @126
        b = self.opened(self.sell(self.seller, "100", "124"))  # resting @124
        c = self.opened(self.buy(self.buyer, "150", "125"))
        # buyer can only afford the cheaper resting sell: 124 < 126
        mb = child_map(self.status(self.seller, b))
        self.assertNotIn("open", mb)
        self.assertEqual(mb["executed"][0].attrib["price"], "124")
        ma = child_map(self.status(self.seller, a))
        self.assertEqual(ma["open"][0].attrib["shares"], "100")
        mc = child_map(self.status(self.buyer, c))
        self.assertEqual(mc["executed"][0].attrib["price"], "124")
        self.assertEqual(mc["open"][0].attrib["shares"], "50")

    def test_time_priority(self):
        a = self.opened(self.sell(self.seller, "100", "125"))  # arrived first
        b = self.opened(self.sell(self.seller, "100", "125"))  # arrived second
        c = self.opened(self.buy(self.buyer, "150", "125"))
        # a is filled completely, b only partially -> arrival order matters
        ma = child_map(self.status(self.seller, a))
        self.assertNotIn("open", ma)
        self.assertEqual(ma["executed"][0].attrib["shares"], "100")
        mb = child_map(self.status(self.seller, b))
        self.assertEqual(mb["executed"][0].attrib["shares"], "50")
        self.assertEqual(mb["open"][0].attrib["shares"], "50")

    def test_invalid_account(self):
        r = send(transactions("404040404", order("X", "1", "1")))
        ks = kids(r)
        self.assertEqual(ks[0][0], "error")
        self.assertEqual(ks[0][1], {"sym": "X", "amount": "1", "limit": "1"})
        self.assertIn("Invalid account", ks[0][2])
        r2 = send(transactions("404040404", query("1")))
        self.assertEqual(kids(r2)[0][1], {"id": "1"})
        r3 = send(transactions("404040404", cancel("1")))
        self.assertEqual(kids(r3)[0][1], {"id": "1"})

    def test_duplicate_account(self):
        r = send(create(acct("777777", "10"), acct("777777", "20")))
        ks = kids(r)
        self.assertEqual(ks[0][0], "created")
        self.assertEqual(ks[1][0], "error")
        self.assertEqual(ks[1][1], {"id": "777777"})
        self.assertIn("already exists", ks[1][2])

    def test_symbol_create_error_and_order(self):
        # symbol referencing a non-existent account -> error
        r = send(create(symbol("NEWSYM", holder("404404", "5"))))
        ks = kids(r)
        self.assertEqual(ks[0][0], "error")
        self.assertEqual(ks[0][1], {"sym": "NEWSYM", "id": "404404"})
        self.assertIn("Account does not exist", ks[0][2])
        # create-children are processed in input order: symbol error first,
        # then the account creation succeeds
        r2 = send(create(symbol("SYM2", holder("505505", "3")), acct("505505", "1")))
        ks2 = kids(r2)
        self.assertEqual(ks2[0][0], "error")
        self.assertEqual(ks2[1][0], "created")
        # account created later can be used by a later symbol child
        r3 = send(create(symbol("SYM3", holder("505505", "7"))))
        self.assertEqual(kids(r3)[0][0], "created")

    def test_symbol_extends_position(self):
        r = send(create(symbol(self.sym, holder(self.seller, "5000"))))
        self.assertEqual(kids(r)[0][0], "created")
        # position is now 105,000
        self.assertEqual(kids(self.sell(self.seller, "105000", "10"))[0][0], "opened")
        r2 = self.sell(self.seller, "100000", "10")
        self.assertEqual(kids(r2)[0][0], "error")

    def test_atomicity_consistent(self):
        # seller sells 100 @ 10; buyer buys 100 @ 10 -> cross at 10
        self.opened(self.sell(self.seller, "100", "10"))
        self.opened(self.buy(self.buyer, "100", "10"))
        # buyer must now own 100 shares (can sell them)
        r = self.sell(self.buyer, "100", "1")
        self.assertEqual(kids(r)[0][0], "opened")
        # seller must have been credited 100 * 10 = 1000 (can buy 100 @ 10)
        r2 = self.buy(self.seller, "100", "10")
        self.assertEqual(kids(r2)[0][0], "opened")

    def test_query_invalid_id(self):
        r = send(transactions(self.buyer, query("999999999")))
        ks = kids(r)
        self.assertEqual(ks[0][0], "error")
        self.assertEqual(ks[0][1], {"id": "999999999"})
        self.assertIn("Invalid transaction id", ks[0][2])

    def test_cancel_invalid_id(self):
        r = send(transactions(self.buyer, cancel("999999999")))
        ks = kids(r)
        self.assertEqual(ks[0][0], "error")
        self.assertEqual(ks[0][1], {"id": "999999999"})
        self.assertIn("Invalid transaction id", ks[0][2])

    def test_double_cancel(self):
        oid = self.opened(self.buy(self.buyer, "10", "5"))
        r1 = self.cancel_reply(self.buyer, oid)
        self.assertEqual(len(child_map(r1)["canceled"]), 1)
        r2 = send(transactions(self.buyer, cancel(oid)))
        ks = kids(r2)
        self.assertEqual(ks[0][0], "error")
        self.assertIn("already canceled", ks[0][2])

    def test_cancel_fully_executed(self):
        self.opened(self.sell(self.seller, "100", "125"))
        b = self.opened(self.buy(self.buyer, "100", "125"))
        r = self.cancel_reply(self.buyer, b)
        m = child_map(r)
        self.assertNotIn("canceled", m)          # nothing open was canceled
        self.assertEqual(len(m["executed"]), 1)  # history is preserved
        self.assertEqual(m["executed"][0].attrib["price"], "125")

    def test_equal_price_cross(self):
        b = self.opened(self.buy(self.buyer, "100", "125"))
        self.opened(self.sell(self.seller, "100", "125"))
        m = child_map(self.status(self.buyer, b))
        self.assertNotIn("open", m)
        self.assertEqual(m["executed"][0].attrib["shares"], "100")
        self.assertEqual(m["executed"][0].attrib["price"], "125")

    def test_partial_execution_then_cancel(self):
        b = self.opened(self.buy(self.buyer, "300", "125"))
        self.opened(self.sell(self.seller, "100", "125"))
        r = self.cancel_reply(self.buyer, b)
        m = child_map(r)
        self.assertEqual(m["executed"][0].attrib["shares"], "100")
        self.assertEqual(m["canceled"][0].attrib["shares"], "200")
        # subsequent query shows the same history
        m2 = child_map(self.status(self.buyer, b))
        self.assertEqual(m2["executed"][0].attrib["shares"], "100")
        self.assertEqual(m2["canceled"][0].attrib["shares"], "200")

    def test_fractional_values(self):
        aid = acct_id()
        send(create(acct(aid, "1000.50")))
        r = send(transactions(aid, order("FRAC", "10.5", "12.25")))
        ks = kids(r)
        self.assertEqual(ks[0][0], "opened")
        self.assertEqual(ks[0][1]["amount"], "10.5")
        self.assertEqual(ks[0][1]["limit"], "12.25")
        # cost = 10.5 * 12.25 = 128.625, leaving 871.875
        self.assertEqual(kids(send(transactions(aid, order("FRAC", "70", "12.45"))))[0][0],
                         "opened")   # 871.5 <= 871.875
        r2 = send(transactions(aid, order("FRAC", "1", "871.876")))
        self.assertEqual(kids(r2)[0][0], "error")   # 871.876 > 871.875
        # fractional shares
        s = self.opened(self.sell(self.seller, "2.5", "10"))
        m = child_map(self.status(self.seller, s))
        self.assertEqual(m["open"][0].attrib["shares"], "2.5")

    def test_multiple_requests_one_connection(self):
        roots = send_multi([
            transactions(self.buyer, order(self.sym, "10", "5")),
        ])
        oid = roots[0][0].attrib["id"]
        roots2 = send_multi([
            transactions(self.buyer, query(oid)),
        ])
        st = roots2[0][0]
        self.assertEqual(st.tag.rsplit("}", 1)[-1], "status")
        m = child_map(st)
        self.assertEqual(m["open"][0].attrib["shares"], "10")

    def test_response_order_matches_request(self):
        # one transactions request with order+query+cancel children must
        # produce responses in the same order
        oid = self.opened(self.buy(self.buyer, "10", "5"))
        r = send(transactions(self.buyer, query(oid), cancel(oid)))
        tags = [c.tag.rsplit("}", 1)[-1] for c in r]
        self.assertEqual(tags, ["status", "canceled"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
