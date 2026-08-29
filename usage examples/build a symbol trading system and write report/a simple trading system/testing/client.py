#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Black-box client helpers for talking to the exchange server.

The tests only speak the wire protocol: a line with the byte length of the
XML payload, then exactly that many bytes of XML.  Every helper here builds
requests and parses responses; nothing reaches into the server's memory.
"""

import socket
import xml.etree.ElementTree as ET

HOST = "127.0.0.1"
PORT = 12345
TIMEOUT = 10.0


def send(payload, host=HOST, port=PORT, timeout=TIMEOUT):
    """Send one length-prefixed XML request, return the parsed <results> root.

    The write side is shut down after sending so the server sees end-of-
    request-stream and closes the connection after replying (the server also
    supports several requests on one connection, see send_multi).
    """
    data = payload.encode("utf-8")
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.sendall(("%d\n" % len(data)).encode("ascii") + data)
        s.shutdown(socket.SHUT_WR)
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    return ET.fromstring(buf)


def send_multi(requests, host=HOST, port=PORT, timeout=TIMEOUT):
    """Send several requests over a single connection.

    Returns the list of parsed response roots, one per request.  The server
    replies once per request, so we read one complete XML document at a time.
    """
    roots = []
    with socket.create_connection((host, port), timeout=timeout) as s:
        for payload in requests:
            data = payload.encode("utf-8")
            s.sendall(("%d\n" % len(data)).encode("ascii") + data)
            buf = b""
            while True:
                try:
                    buf += s.recv(65536)
                except socket.timeout:
                    raise AssertionError("timeout waiting for response to %r" % payload)
                if not buf:
                    raise AssertionError("connection closed before a response to %r" % payload)
                try:
                    roots.append(ET.fromstring(buf))
                    break
                except ET.ParseError:
                    continue  # response not complete yet
        s.shutdown(socket.SHUT_WR)
        if s.recv(4096) != b"":
            raise AssertionError("server did not close the connection after EOF")
    return roots


# ---------------------------------------------------------------------------
# Request builders
# ---------------------------------------------------------------------------

def create(*children):
    return "<create>%s</create>" % "".join(children)


def acct(acct_id, balance):
    return '<account id="%s" balance="%s"/>' % (acct_id, balance)


def symbol(sym, *holders):
    return '<symbol sym="%s">%s</symbol>' % (sym, "".join(holders))


def holder(acct_id, shares):
    return '<account id="%s">%s</account>' % (acct_id, shares)


def transactions(acct_id, *children):
    return '<transactions id="%s">%s</transactions>' % (acct_id, "".join(children))


def order(sym, amount, limit):
    return '<order sym="%s" amount="%s" limit="%s"/>' % (sym, amount, limit)


def query(oid):
    return '<query id="%s"/>' % oid


def cancel(oid):
    return '<cancel id="%s"/>' % oid


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------

def kids(root):
    """Return [(tag, attrs, text), ...] of root's children, in order."""
    return [
        (c.tag.rsplit("}", 1)[-1], dict(c.attrib), (c.text or "").strip())
        for c in root
    ]


def child_map(element):
    """Return {tag: [Element]} for the children of an XML element."""
    m = {}
    for c in element:
        m.setdefault(c.tag.rsplit("}", 1)[-1], []).append(c)
    return m
