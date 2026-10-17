#!/usr/bin/env python3
"""Prove the Iran -> foreign path before any template is judged.

Both halves of a template run in freshly created network namespaces. The first
connection between them can fail while ARP and bridge forwarding settle, and
WaterWall retries a failed dial on its own schedule (tens of seconds for an
authentication client), so that one lost handshake looks exactly like a tunnel
that does not work.

The harness therefore opens one plain TCP connection from the Iran namespace to
a throwaway listener in the foreign namespace first. `listen` and `connect` are
separate invocations so the listener can be started inside one namespace and
the connection attempted from inside the other.

    warm.py listen  <port> <seconds>
    warm.py connect <host> <port> <seconds>
"""

import json
import socket
import sys
import time


def listen(port, seconds):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(8)
    srv.settimeout(0.2)
    end = time.time() + seconds
    accepted = 0
    while time.time() < end:
        try:
            conn, _ = srv.accept()
            conn.close()
            accepted += 1
        except socket.timeout:
            continue
        except OSError:
            break
    print(json.dumps({"accepted": accepted}))


def connect(host, port, seconds):
    started = time.time()
    end = started + seconds
    attempts = 0
    err = "no attempt"
    while time.time() < end:
        attempts += 1
        s = socket.socket()
        s.settimeout(1.0)
        try:
            s.connect((host, port))
            print(json.dumps({"ok": True, "attempts": attempts, "ms": int((time.time() - started) * 1000)}))
            return
        except OSError as exc:
            err = str(exc)
        finally:
            s.close()
        time.sleep(0.2)
    print(json.dumps({"ok": False, "attempts": attempts, "error": err}))


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "listen":
        listen(int(sys.argv[2]), float(sys.argv[3]))
    else:
        connect(sys.argv[2], int(sys.argv[3]), float(sys.argv[4]))
