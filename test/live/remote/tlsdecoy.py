#!/usr/bin/env python3
"""A minimal HTTPS decoy for the relay live test.

The relay's RealityServer forwards an unauthorized (or pre-takeover) TLS
handshake to its `destination`. The harness points that destination at this
local server instead of a real site, so the test does not depend on the test
box's outbound internet or DNS. The generated certificate is for example.com;
the test sets `realityVerify: false` because it is self-signed.
"""

import http.server
import socketserver
import ssl
import sys

CERT, KEY, HOST, PORT = sys.argv[1:5]


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        body = b"DECOY-OK"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    httpd = Server((HOST, int(PORT)), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"decoy up on {HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
