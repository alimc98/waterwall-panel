'use strict';

/**
 * IPv4 protocol-number probe.
 *
 * Sends a real IPv4 packet with an arbitrary Protocol field value and reports
 * whether the peer answers. This is what tells you which protocol numbers are
 * actually usable for `protoswap` on your route: a number can be perfectly
 * legal in a config and still be filtered in transit.
 *
 * The sender is a raw socket (IP_HDRINCL), so it needs root or CAP_NET_RAW.
 * The panel refuses to run it otherwise.
 */

const dgram = require('node:dgram');
const net = require('node:net');

const IPPROTO_ICMP = 1;
const PROTO_ECHO_REQUEST = 8;
const PROTO_ECHO_REPLY = 0;

// 20-byte IPv4 header + 8-byte ICMP header.
const PAYLOAD_OFFSET = 28;
const PROBE_LENGTH = 36;

/** Internet checksum over a 16-bit-word-aligned buffer. */
function checksum16(buffer) {
  let sum = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    sum += (buffer[i] << 8) + buffer[i + 1];
  }
  if (buffer.length % 2) sum += buffer[buffer.length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

/** IPv4 addresses as 4-byte buffers. */
function ipToBuf(address) {
  const parts = String(address).trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`invalid IPv4 address: ${address}`);
  }
  return Buffer.from(parts);
}

/**
 * Build an echo request with a custom IPv4 Protocol field.
 *
 * Layout: 20-byte IPv4 header + 8-byte ICMP header (type/code/checksum unused)
 * + 8-byte payload carrying a token, so the reply can be matched to this exact
 * probe even when several numbers are being tested at once.
 */
function buildProbe({ src, dst, protocol, id, token }) {
  const srcBuf = ipToBuf(src);
  const dstBuf = ipToBuf(dst);

  const payload = Buffer.alloc(8);
  payload.writeUInt16BE(id, 0);
  payload.writeUInt32BE(token >>> 0, 2);
  payload.writeUInt16BE(0x5741, 6); // "WA" magic, distinguishes our probes

  const icmp = Buffer.alloc(8);
  icmp[0] = 8; // echo request
  icmp[1] = 0; // code
  icmp.writeUInt16BE(0, 2); // checksum placeholder
  icmp.writeUInt16BE(id, 4); // identifier
  icmp.writeUInt16BE(0, 6); // sequence
  icmp.writeUInt16BE(checksum16(Buffer.concat([icmp, payload])), 2);

  const header = Buffer.alloc(20);
  header[0] = 0x45; // IPv4, 20-byte header
  header.writeUInt16BE(20 + icmp.length + payload.length, 2); // total length
  header.writeUInt16BE(id & 0xffff, 4); // identification
  header.writeUInt16BE(0x4000, 6); // don't fragment
  header[8] = 64; // TTL
  header[9] = protocol & 0xff; // <-- the whole point
  header.writeUInt16BE(0, 10); // checksum placeholder
  srcBuf.copy(header, 12);
  dstBuf.copy(header, 16);
  header.writeUInt16BE(checksum16(header), 10);

  return Buffer.concat([header, icmp, payload]);
}

function canSendRaw() {
  if (process.platform !== 'linux') {
    return { ok: false, error: 'protocol probing needs a raw socket, which this platform does not expose here' };
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { ok: false, error: 'raw sockets need root (or CAP_NET_RAW)' };
  }
  return { ok: true };
}

/** Find the source address the kernel would use to reach `dst`. */
function routeSourceFor(dst) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    try {
      socket.connect(53, dst, () => {
        const { address } = socket.address();
        socket.close();
        resolve(address);
      });
    } catch {
      socket.close();
      resolve(null);
    }
  });
}

/**
 * Send one probe with the given protocol number and wait for a reply.
 * Resolves { ok, protocol, latencyMs, error }.
 */
function probeOnce({ src, dst, protocol, timeout = 1500, id = 1 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const token = (Math.random() * 0xffffffff) >>> 0;
    let settled = false;
    let socket = null;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve({ protocol, ...result, latencyMs: Date.now() - started });
    };

    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeout);

    try {
      socket = new net.Socket({ type: 'raw' }); // raw IPv4 socket
    } catch (err) {
      return done({ ok: false, error: `cannot open raw socket: ${err.code || err.message}` });
    }

    socket.on('error', (err) => done({ ok: false, error: err.code || err.message }));

    try {
      const packet = buildProbe({ src, dst, protocol, id, token });
      socket.send(packet, 0, packet.length, (err) => {
        if (err) done({ ok: false, error: err.code || err.message });
      });
    } catch (err) {
      done({ ok: false, error: err.code || err.message });
    }

    // Listen for the matching echo reply on a separate raw socket: replies come
    // back carrying the same swapped protocol, so we match on our own token.
    // Layout: 20-byte IPv4 header + 8-byte ICMP header, then the 8-byte payload
    // (2 id, 4 token, 2 magic).
    let listener = null;
    try {
      listener = new net.Socket({ type: 'raw', proto: protocol & 0xff });
      listener.on('data', (data) => {
        if (data.length < PROBE_LENGTH) return;
        if (data[9] !== (protocol & 0xff)) return; // only our protocol
        if (data.readUInt16BE(PAYLOAD_OFFSET + 6) === 0x5741 && data.readUInt32BE(PAYLOAD_OFFSET + 2) === (token >>> 0)) {
          done({ ok: true });
          try {
            listener.close();
          } catch {
            /* ignore */
          }
        }
      });
      listener.on('error', () => {
        /* receiving with an arbitrary protocol may be denied; rely on timeout */
      });
    } catch {
      listener = null;
    }
  });
}

/**
 * Test a list of protocol numbers in sequence. Returns a report with a verdict
 * per number plus a ranked recommendation.
 */
async function probeProtocols({
  protocols,
  dst,
  src = null,
  timeout = 1500,
  attempts = 2,
  onProgress = null,
}) {
  const gate = canSendRaw();
  if (!gate.ok) return { ok: false, error: gate.error, results: [] };

  const source = src || (await routeSourceFor(dst));
  if (!source) return { ok: false, error: 'could not determine a source address for the route', results: [] };

  const results = [];
  for (const protocol of protocols) {
    let hits = 0;
    let lastError = null;
    let best = null;
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await probeOnce({
        src: source,
        dst,
        protocol,
        timeout,
        id: 1000 + attempt,
      });
      if (r.ok) {
        hits += 1;
        best = r.latencyMs;
      } else {
        lastError = r.error;
      }
      onProgress?.({ protocol, attempt, ok: r.ok });
    }
    results.push({
      protocol,
      ok: hits > 0,
      hits,
      attempts,
      latencyMs: best,
      error: hits > 0 ? null : lastError,
      verdict: hits > 0 ? 'open' : 'blocked',
    });
  }

  const open = results.filter((r) => r.ok);
  const blocked = results.filter((r) => !r.ok);
  return {
    ok: true,
    source,
    destination: dst,
    results,
    summary: {
      tested: results.length,
      open: open.length,
      blocked: blocked.length,
      best: open.length ? open.sort((a, b) => a.latencyMs - b.latencyMs)[0].protocol : null,
      openList: open.map((r) => r.protocol),
      blockedList: blocked.map((r) => r.protocol),
    },
  };
}

module.exports = {
  probeProtocols,
  probeOnce,
  canSendRaw,
  buildProbe,
  checksum16,
  routeSourceFor,
  IPPROTO_ICMP,
  PROTO_ECHO_REQUEST,
  PROTO_ECHO_REPLY,
};
