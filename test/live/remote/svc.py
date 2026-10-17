#!/usr/bin/env python3
"""The service the harness tunnels traffic to.

Listens on the harness host address only, so nothing here is ever reachable
from the real internet:

    10.200.0.1:9001   TCP echo and UDP echo (same port, both protocols)
    10.200.0.1:9002   HTTP, answers with a fixed body

A tunnel "works" when a payload sent to its entry point comes back unchanged
from here.
"""

import socket
import socketserver
import sys
import threading

HOST = "10.200.0.1"
ECHO_PORT = 9001
HTTP_PORT = 9002
BODY = b"HARNESS-OK"

stop = threading.Event()


class TcpEcho(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(20)
        try:
            while not stop.is_set():
                data = self.request.recv(65536)
                if not data:
                    return
                self.request.sendall(data)
        except (socket.timeout, ConnectionResetError, OSError):
            return


class Http(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(20)
        try:
            buf = b""
            while b"\r\n\r\n" not in buf and len(buf) < 65536:
                chunk = self.request.recv(4096)
                if not chunk:
                    break
                buf += chunk
        except (socket.timeout, OSError):
            return
        resp = (
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: text/plain\r\n"
            b"Content-Length: " + str(len(BODY)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n" + BODY
        )
        try:
            self.request.sendall(resp)
        except OSError:
            pass


class UdpEcho(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        sock.sendto(data, self.client_address)


class Reuse(socketserver.TCPServer):
    allow_reuse_address = True


class ReuseUdp(socketserver.UDPServer):
    allow_reuse_address = True


def main():
    servers = [
        Reuse((HOST, ECHO_PORT), TcpEcho),
        Reuse((HOST, HTTP_PORT), Http),
        ReuseUdp((HOST, ECHO_PORT), UdpEcho),
    ]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"service up on {HOST}: tcp/udp {ECHO_PORT}, http {HTTP_PORT}", flush=True)
    try:
        stop.wait()
    except KeyboardInterrupt:
        pass
    for s in servers:
        s.shutdown()


if __name__ == "__main__":
    sys.exit(main())
