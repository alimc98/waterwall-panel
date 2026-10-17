#!/usr/bin/env python3
"""Traffic probes. One process, one probe, JSON on stdout.

    probe.py tcp        <host> <port>
    probe.py udp        <host> <port>
    probe.py socks5     <host> <port> <target-host:port> [user:pass]
    probe.py http       <host> <port> <url>
    probe.py tun-web    <host:port>

`tcp`, `udp` and `socks5` send a random marker and require the exact bytes
back, so a half-open connection that forwards nothing cannot pass. `socks5`
reports which authentication method the server picked, which is the only way
to tell "no-auth really is on" apart from "auth is required but nothing can
satisfy it".
"""

import json
import os
import random
import socket
import sys


def marker():
    return f"WWPROBE-{random.randrange(1 << 40):010x}".encode()


def recv_exact(sock, want, deadline=15.0):
    sock.settimeout(deadline)
    buf = b""
    while len(buf) < want:
        chunk = sock.recv(want - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf


def echo_over(sock, label):
    """Send a marker, require it back byte for byte."""
    mark = marker()
    sock.sendall(mark)
    got = recv_exact(sock, len(mark))
    if got == mark:
        return True, f"{label}: {len(mark)} bytes echoed back unchanged"
    if not got:
        return False, f"{label}: connected but nothing came back"
    return False, f"{label}: expected {mark!r}, got {got!r}"


def probe_tcp(host, port, _extra):
    try:
        s = socket.create_connection((host, port), 10)
    except OSError as e:
        return False, f"cannot connect to {host}:{port}: {e}"
    try:
        return echo_over(s, f"tcp {host}:{port}")
    finally:
        s.close()


def probe_udp(host, port, _extra):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(10)
    mark = marker()
    try:
        s.sendto(mark, (host, port))
        got, _ = s.recvfrom(65536)
    except OSError as e:
        return False, f"udp {host}:{port}: {e}"
    finally:
        s.close()
    if got == mark:
        return True, f"udp {host}:{port}: {len(mark)} bytes echoed back unchanged"
    return False, f"udp {host}:{port}: expected {mark!r}, got {got!r}"


def socks5_connect(sock, host, port, creds):
    """Negotiate and CONNECT. Returns (ok, detail)."""
    sock.sendall(bytes([5, 1, 2 if creds else 0]))
    head = recv_exact(sock, 2)
    if len(head) < 2:
        return False, "server closed during method negotiation"
    if head[0] != 5:
        return False, f"not a SOCKS5 reply: {head!r}"
    method = head[1]
    if method == 0xFF:
        return False, (
            "server rejected every auth method we offered (0xFF) — "
            "it requires authentication but the generated config declares no accounts"
        )
    if method == 2:
        if not creds:
            return False, "server demands username/password but the config shipped none"
        u, _, p = creds.partition(":")
        ub, pb = u.encode(), p.encode()
        sock.sendall(bytes([1, len(ub)]) + ub + bytes([len(pb)]) + pb)
        sub = recv_exact(sock, 2)
        if len(sub) < 2 or sub[1] != 0:
            return False, f"username/password rejected: {sub!r}"
    elif method != 0:
        return False, f"server chose unsupported method {method}"

    hb = host.encode()
    sock.sendall(bytes([5, 1, 0, 3, len(hb)]) + hb + port.to_bytes(2, "big"))
    rep = recv_exact(sock, 4)
    if len(rep) < 4:
        return False, "server closed during CONNECT"
    if rep[1] != 0:
        return False, f"CONNECT refused with code {rep[1]}"
    # consume the bound address so the stream is aligned
    if rep[3] == 1:
        recv_exact(sock, 4 + 2)
    elif rep[3] == 3:
        n = recv_exact(sock, 1)
        recv_exact(sock, (n[0] if n else 0) + 2)
    elif rep[3] == 4:
        recv_exact(sock, 16 + 2)
    return True, f"SOCKS5 method={method} CONNECT {host}:{port} accepted"


def probe_socks5(host, port, extra):
    if not extra:
        return False, "missing target"
    target, _, creds = extra.partition(" ")
    thost, _, tport = target.rpartition(":")
    try:
        s = socket.create_connection((host, port), 10)
    except OSError as e:
        return False, f"cannot connect to {host}:{port}: {e}"
    try:
        ok, detail = socks5_connect(s, thost, int(tport), creds or None)
        if not ok:
            return False, detail
        ok, echoed = echo_over(s, "through SOCKS5")
        return ok, f"{detail}; {echoed}"
    finally:
        s.close()


def probe_http(host, port, extra):
    url = extra or f"http://{host}:8000/"
    _, _, rest = url.partition("://")
    authority = rest.split("/")[0]
    pathpart = "/" + rest.split("/", 1)[1] if "/" in rest else "/"
    req = (
        f"GET {url} HTTP/1.1\r\nHost: {authority}\r\n"
        "User-Agent: ww-harness\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    ).encode()
    try:
        s = socket.create_connection((host, port), 10)
    except OSError as e:
        return False, f"cannot connect to {host}:{port}: {e}"
    try:
        s.sendall(req)
        buf = b""
        s.settimeout(15)
        while len(buf) < 65536:
            try:
                chunk = s.recv(4096)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
    finally:
        s.close()
    if not buf:
        return False, f"http proxy {host}:{port}: no response for {url}"
    if b"HARNESS-OK" in buf:
        return True, f"http proxy {host}:{port}: fetched {url} and got the test body"
    status = buf.split(b"\r\n", 1)[0]
    return False, f"http proxy {host}:{port}: {status!r} for {pathpart}, body lacked the marker"


def probe_tun_web(_host, _port, extra):
    """Everything this namespace sends must leave through the tunnel."""
    target = extra or "1.1.1.1:80"
    thost, _, tport = target.rpartition(":")
    try:
        s = socket.create_connection((thost, int(tport)), 12)
    except OSError as e:
        return False, f"no route through the tunnel to {target}: {e}"
    try:
        s.sendall(f"GET / HTTP/1.0\r\nHost: {thost}\r\n\r\n".encode())
        s.settimeout(15)
        buf = b""
        while len(buf) < 4096:
            try:
                chunk = s.recv(1024)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
    finally:
        s.close()
    if buf.startswith(b"HTTP/"):
        return True, f"full tunnel: {buf.split(b' ')[1].decode(errors='replace')} from {target}"
    if buf:
        return True, f"full tunnel: {len(buf)} bytes came back from {target}"
    return False, f"connected to {target} through the tunnel but no data returned"


PROBES = {
    "tcp": probe_tcp,
    "udp": probe_udp,
    "socks5": probe_socks5,
    "socks5-auth": probe_socks5,
    "http": probe_http,
    "tun-web": probe_tun_web,
}


def main(argv):
    if len(argv) < 4:
        print(json.dumps({"ok": False, "detail": "usage: probe.py <proto> <host> <port> [extra]"}))
        return 2
    proto, host, port = argv[1], argv[2], argv[3]
    extra = argv[4] if len(argv) > 4 else ""
    fn = PROBES.get(proto)
    if not fn:
        print(json.dumps({"ok": False, "detail": f"unknown proto {proto}"}))
        return 2
    try:
        ok, detail = fn(host, int(port), extra)
    except Exception as e:  # noqa: BLE001 - a probe crash is a failed probe
        ok, detail = False, f"{type(e).__name__}: {e}"
    print(json.dumps({"ok": ok, "detail": detail}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
