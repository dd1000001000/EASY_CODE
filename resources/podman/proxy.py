"""Container-local TCP relay. No host addresses, files, or control credentials.

Each stream is forwarded over Podman exec stdio to ONE per-command HTTP gate.
This process is untrusted; all destination/approval checks happen on the host.
"""
import base64
import json
import os
import selectors
import socket
import sys

sel = selectors.DefaultSelector()
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 18080))
server.listen(32)
server.setblocking(False)
sel.register(server, selectors.EVENT_READ, "listen")
sel.register(sys.stdin, selectors.EVENT_READ, "input")
clients = {}
sequence = 0
pending = b""

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def close(key):
    sock = clients.pop(key, None)
    if sock:
        sel.unregister(sock)
        sock.close()

emit({"type": "ready"})
while True:
    for event, _ in sel.select():
        kind = event.data
        if kind == "listen":
            sock, _ = server.accept()
            # A stalled local consumer cannot block every relay stream forever.
            sock.settimeout(1)
            if len(clients) >= 32:
                sock.close()
                continue
            sequence += 1
            clients[sequence] = sock
            sel.register(sock, selectors.EVENT_READ, sequence)
            emit({"type": "open", "id": sequence})
        elif kind == "input":
            chunk = os.read(sys.stdin.fileno(), 32768)
            if not chunk:
                sys.exit(0)
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                value = json.loads(line)
                sock = clients.get(value["id"])
                if sock and value["type"] == "data":
                    try:
                        sock.sendall(base64.b64decode(value["data"], validate=True))
                    except OSError:
                        close(value["id"])
                elif value["type"] == "close":
                    close(value["id"])
            if len(pending) > 65536:
                sys.exit(1)
        else:
            sock = clients.get(kind)
            try:
                chunk = sock.recv(16384)
            except OSError:
                chunk = b""
            if chunk:
                emit({"type": "data", "id": kind, "data": base64.b64encode(chunk).decode("ascii")})
            else:
                close(kind)
                emit({"type": "close", "id": kind})
