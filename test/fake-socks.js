'use strict';

/**
 * A throwaway SOCKS5 proxy used to verify lib/tests.js end to end.
 * It terminates SOCKS5 and forwards the request to a local HTTP "exit" that
 * reports a fake public IP, so the panel's /api/test/socks and /api/test/speed
 * endpoints can be exercised without a real tunnel.
 *
 *   node test/fake-socks.js 10999
 *
 * Then point the panel's test page at 127.0.0.1:10999.
 */

const net = require('node:net');
const http = require('node:http');

const PORT = Number(process.argv[2] || 10999);
const FAKE_IP = '203.0.113.42';

// ------------------------------------------------------------------ "exit"
const exitServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__down') {
    const bytes = Number(url.searchParams.get('bytes') || 1048576);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes) });
    const chunk = Buffer.alloc(65536, 0x41);
    let sent = 0;
    const write = () => {
      while (sent < bytes) {
        const n = Math.min(chunk.length, bytes - sent);
        sent += n;
        if (!res.write(chunk.subarray(0, n))) {
          res.once('drain', write);
          return;
        }
      }
      res.end();
    };
    write();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`${FAKE_IP}\n`);
});

// ------------------------------------------------------------ socks server
function parseRequest(buf) {
  if (buf.length < 5) return null;
  const version = buf[0];
  const atype = buf[3];
  if (version !== 0x05) return null;
  if (atype === 0x01) {
    if (buf.length < 10) return null;
    return { host: `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`, port: buf.readUInt16BE(8), length: 10 };
  }
  if (atype === 0x03) {
    const len = buf[4];
    if (buf.length < 5 + len + 2) return null;
    return { host: buf.toString('utf8', 5, 5 + len), port: buf.readUInt16BE(5 + len), length: 7 + len };
  }
  if (atype === 0x04) {
    if (buf.length < 22) return null;
    // ::ffff:a.b.c.d
    const v4 = Array.from(buf.subarray(18, 22)).join('.');
    return { host: `::ffff:${v4}`, port: buf.readUInt16BE(20), length: 22 };
  }
  return null; // ATYP 0x04 (IPv6) is not needed for the tests
}

const socks = net.createServer((client) => {
  let greeted = false;
  let request = null;
  let buf = Buffer.alloc(0);

  // Once the request is parsed, behave like a real tunnel: hand the raw bytes
  // to the "exit" and stream both directions back and forth.
  const relay = () => {
    const upstream = net.connect(exitServer.address().port, '127.0.0.1');
    upstream.on('error', () => client.destroy());
    upstream.pipe(client);
    client.pipe(upstream);
  };

  client.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    if (!greeted) {
      if (buf.length < 2) return;
      if (buf[0] !== 0x05) return client.destroy();
      // VER, NMETHODS, METHODS... — consume the whole greeting before replying.
      if (buf.length < 2 + buf[1]) return;
      buf = buf.subarray(2 + buf[1]);
      greeted = true;
      client.write(Buffer.from([0x05, 0x00])); // no auth
    }

    if (greeted && !request) {
      request = parseRequest(buf);
      if (!request) return;
      buf = buf.subarray(request.length);
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      relay();
      if (buf.length) client.unshift(buf); // forward any pipelined payload
    }
  });

  client.on('error', () => client.destroy());
});

exitServer.listen(0, '127.0.0.1', () => {
  socks.listen(PORT, '127.0.0.1', () => {
    console.log(`fake SOCKS5 on 127.0.0.1:${PORT} (exit reports ${FAKE_IP})`);
  });
});
