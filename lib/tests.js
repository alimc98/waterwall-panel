'use strict';

const net = require('node:net');
const dgram = require('node:dgram');
const dns = require('node:dns');

/**
 * Connectivity tests used by the panel's "Test" button.
 * Everything is implemented with core Node modules so the panel stays
 * dependency-free.
 */

/** TCP connect test with latency measurement. */
function tcpProbe({ host, port, timeout = 6000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, error: 'timeout' }));
    socket.once('error', (err) => done({ ok: false, error: err.code || err.message }));
    socket.connect({ host, port });
  });
}

/**
 * End-to-end test: speak SOCKS5 to the panel-side entry point and fetch a URL
 * through it. This proves the whole tunnel chain (listener -> protocol ->
 * connector -> internet) actually carries traffic.
 */
function socks5HttpTest({
  host,
  port,
  targetHost = 'api.ipify.org',
  targetPort = 80,
  path = '/',
  timeout = 12000,
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stage = 'connect';
    let settled = false;
    const socket = new net.Socket();

    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - started });
    };

    socket.setTimeout(timeout);
    socket.on('timeout', () => done({ ok: false, error: `timeout during ${stage}` }));
    socket.on('error', (err) => done({ ok: false, error: `${stage}: ${err.code || err.message}` }));
    socket.on('close', () => done({ ok: false, error: `connection closed during ${stage}` }));

    socket.on('data', (buf) => {
      if (stage === 'greeting') {
        // VER, NMETHODS, METHODS -> expect a 2-byte "no auth required" reply.
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return done({ ok: false, error: 'not a SOCKS5 server' });
        if (buf[1] !== 0x00) return done({ ok: false, error: 'SOCKS5 server requires authentication' });
        stage = 'request';
        // CONNECT <host>:<port>
        const hostBuf = Buffer.from(String(targetHost), 'utf8');
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(Number(targetPort) >> 8) & 0xff, Number(targetPort) & 0xff]),
          ]),
        );
        return;
      }

      if (stage === 'request') {
        if (buf.length < 10) return;
        if (buf[1] !== 0x00) {
          return done({ ok: false, error: `SOCKS5 connect rejected (code ${buf[1]})` });
        }
        stage = 'http';
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: wwpanel\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
        );
        return;
      }

      // stage === 'http': the response is arriving.
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const statusLine = buf.toString('latin1', 0, headerEnd).split('\r\n')[0];
      const http = statusLine.split(' ')[1] || '000';
      const body = buf.toString('utf8', headerEnd + 4);
      if (http !== '200') {
        return done({ ok: false, error: `upstream returned HTTP ${http}`, sample: body.slice(0, 200) });
      }
      const reported = body.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      done({
        ok: true,
        ip: reported ? reported[0] : null,
        sample: body.trim().slice(0, 200) || statusLine,
      });
    });

    socket.connect({ host, port }, () => {
      stage = 'greeting';
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
  });
}

/** ICMP ping via the system ping binary (best effort). */
function icmpPing({ host, count = 4, timeout = 15000 }) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const args = isWindows
      ? ['-n', String(count), '-w', '1500', host]
      : ['-c', String(count), '-W', '2', host];
    const child = spawn('ping', args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve({ ok: false, error: 'ping binary not available' }));
    child.on('close', () => {
      const ok = /ttl=/i.test(out) || /time[=<]\s*[\d.]+ *ms/i.test(out);
      resolve({ ok, output: out.trim().split('\n').slice(-6).join('\n') });
    });
    setTimeout(() => child.kill(), timeout);
  });
}

/** Traceroute / path snapshot (best effort). */
function traceRoute({ host, timeout = 30000 }) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const args = isWindows ? ['-d', '10', '-h', '8', host] : ['-n', '-m', '8', '-w', '2', host];
    const child = spawn('tracert', args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve({ ok: false, error: 'tracert binary not available' }));
    child.on('close', () => resolve({ ok: true, output: out.trim().split('\n').slice(-12).join('\n') }));
    setTimeout(() => {
      child.kill();
      resolve({ ok: true, output: out.trim() });
    }, timeout);
  });
}

/**
 * Raw throughput measurement through a SOCKS5 entry point.
 * Downloads a byte range from a public endpoint and reports Mbit/s.
 */
const SPEED_HOST = 'speed.cloudflare.com';

function speedTest({ host, port, bytes = 8 * 1024 * 1024, timeout = 30000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let received = 0;
    let settled = false;
    const socket = new net.Socket();
    let stage = 'greeting';

    const done = (result) => {
      if (settled) return;
      settled = true;
      if (stopTimer) clearTimeout(stopTimer);
      socket.destroy();
      const seconds = (Date.now() - started) / 1000;
      resolve({
        ...result,
        seconds: Number(seconds.toFixed(2)),
        receivedBytes: received,
        mbitPerSec: result.ok ? Number(((received * 8) / seconds / 1e6).toFixed(2)) : 0,
      });
    };

    socket.setTimeout(timeout);
    socket.on('timeout', () => {
      // A socket timeout mid-transfer is normal: report what we received.
      if (received > 0) return done({ ok: true, partial: true });
      done({ ok: false, error: `timeout during ${stage}` });
    });
    socket.on('error', (err) => done({ ok: false, error: `${stage}: ${err.code || err.message}` }));
    socket.on('close', () => {
      if (received > 0) done({ ok: true });
      else done({ ok: false, error: 'connection closed before any data' });
    });
    let headerDone = false;
    let stopTimer = null;
    socket.on('data', (buf) => {
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return done({ ok: false, error: 'not a SOCKS5 server' });
        if (buf[1] !== 0x00) return done({ ok: false, error: 'SOCKS5 server requires authentication' });
        const hostBuf = Buffer.from(SPEED_HOST, 'utf8');
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([0x00, 0x50]), // port 80
          ]),
        );
        stage = 'reply';
        return;
      }
      if (stage === 'reply') {
        if (buf.length < 10) return;
        if (buf[1] !== 0x00) return done({ ok: false, error: `SOCKS5 connect rejected (code ${buf[1]})` });
        stage = 'download';
        socket.write(
          `GET /__down?bytes=${bytes} HTTP/1.1\r\nHost: ${SPEED_HOST}\r\nUser-Agent: wwpanel\r\nConnection: close\r\n\r\n`,
        );
        return;
      }
      received += buf.length;
      if (!headerDone && buf.includes('\r\n\r\n')) {
        headerDone = true;
        // Let the transfer finish (or the socket timeout fire) before reporting.
        clearTimeout(stopTimer);
        stopTimer = setTimeout(() => done({ ok: true }), 400);
      }
    });

    socket.connect({ host, port }, () => {
      stage = 'greeting';
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
  });
}

/**
 * UDP reachability: send a DNS query straight to a resolver and wait for an
 * answer. Used to confirm UDP egress from the local host.
 */
function udpDnsTest({ server = '1.1.1.1', domain = 'one.one.one.one', timeout = 5000 }) {
  return new Promise((resolve) => {
    // Minimal A-record query builder
    const labels = domain.split('.');
    const qname = Buffer.concat([
      ...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'utf8')])),
      Buffer.from([0]),
    ]);
    const query = Buffer.concat([
      Buffer.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      qname,
      Buffer.from([0x00, 0x01, 0x00, 0x01]),
    ]);
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        udp.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    const udp = dgram.createSocket('udp4');
    const started = Date.now();
    udp.on('message', (msg) => done({ ok: true, latencyMs: Date.now() - started, answerBytes: msg.length }));
    udp.on('error', (err) => done({ ok: false, error: err.code || err.message }));
    udp.send(query, 53, server, (err) => {
      if (err) done({ ok: false, error: err.code || err.message });
    });
    setTimeout(() => done({ ok: false, error: 'udp timeout' }), timeout);
  });
}

/** Resolve a domain to A/AAAA records. */
function resolveHost({ host }) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) resolve({ ok: false, error: err.code || err.message });
      else resolve({ ok: true, addresses: addrs });
    });
  });
}

module.exports = {
  tcpProbe,
  socks5HttpTest,
  icmpPing,
  traceRoute,
  speedTest,
  udpDnsTest,
  resolveHost,
};
