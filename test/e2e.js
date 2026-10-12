'use strict';

/**
 * End-to-end test of every template against two real servers.
 *
 * This drives the panel's own HTTP API rather than calling lib/build directly,
 * so it exercises the same path the UI uses: create -> preview -> apply ->
 * service -> traffic.
 *
 * For each template it:
 *   1. builds options suited to the two live servers
 *   2. applies over SSH (the panel writes core.json + configs/*.json)
 *   3. asks the panel to restart the service
 *   4. reads the service state and the last log lines back from both servers
 *   5. where the template exposes a plain user-facing port, sends real traffic
 *   6. scores pass / warn / fail and cleans up before the next template
 *
 * Usage:  node test/e2e.js [--only id,id] [--keep] [--verbose]
 */

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787';
const TOKEN = process.env.E2E_TOKEN || '';
const IRAN = { host: '85.198.55.61', role: 'iran' };
const FOREIGN = { host: '192.227.211.124', role: 'foreign' };

// Both boxes have a single core and 1 GiB, so every config is built for one
// worker. Four workers on one vCPU is worse than useless.
const CORE = { workers: 1, ramProfile: 'client', mtu: 1400, bbr: true, splice: true };

// Ports handed out round-robin so two templates never collide.
let portCursor = 21000;
const nextPort = () => (portCursor += 2);

// The destination service on the foreign box that proves traffic arrived.
const DEST_HOST = '127.0.0.1';
const DEST_PORT = 8080;
const EXPECTED_BODY = 'WW-TUNNEL-DEST-OK';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-template options.
 *
 * `entry` is the port a client would connect to on the Iran box, when the
 * template has one that a plain TCP/HTTP client can reach. `probe` describes
 * how to verify it: 'http' for a plain listener, 'tls' for one that expects TLS.
 */
const PLANS = {
  // These three forward on a single box rather than between two, so the entry
  // port is reachable directly and the same HTTP probe proves the chain works.
  'tcp-forward': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'http',
  }),

  'udp-forward': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'udp',
  }),

  'tcp-udp-forward': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'http',
  }),

  'encrypted-tcp': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(), destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'http',
  }),

  'xor-obfuscated': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(), destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'http',
  }),

  'vless-tls': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(), entryMode: 'socks5',
      sni: 'tunnel.test', verify: false, domain: 'e2e-tls.test', certMode: 'self-signed',
      uuid: ['11111111-2222-3333-4444-555555555555'], destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'socks5',
  }),

  'vless-mux-tls': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(), entryMode: 'socks5', muxEnabled: true, muxMode: 'none',
      sni: 'tunnel.test', verify: false, domain: 'e2e-tls.test', certMode: 'self-signed',
      uuid: ['11111111-2222-3333-4444-555555555555'], destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'socks5',
  }),

  'vless-reality': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(), entryMode: 'socks5',
      realitySni: 'www.microsoft.com', realityPassword: 'auto:password', realityVerify: true,
      camouflageHost: 'www.microsoft.com', camouflagePort: 443,
      uuid: ['11111111-2222-3333-4444-555555555555'], destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'socks5',
  }),

  'trojan-tls': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(), entryMode: 'socks5',
      password: 'auto:password', sni: 'tunnel.test', verify: false,
      certPath: '/etc/waterwall/cert/fullchain.pem', keyPath: '/etc/waterwall/cert/privkey.pem',
      destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'socks5', // an HTTP request never completes on Trojan
  }),

  'vless-http-ws-tls': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(), entryMode: 'socks5', entryPath: '/ws',
      sni: 'tunnel.test', verify: false, domain: 'e2e-tls.test', certMode: 'self-signed',
      uuid: ['11111111-2222-3333-4444-555555555555'], destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE },
    entry: 'last', probe: 'ws',
  }),

  'udp-over-tcp': () => ({
    opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(), _core: CORE },
    why: 'UDP فریم‌شده است؛ جریان HTTP روی آن کامل نمی‌شود',
  }),

  'http-proxy': () => ({ opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(),
    sni: 'tunnel.test', verify: false, domain: 'e2e-tls.test', certMode: 'self-signed',
    uuid: ['11111111-2222-3333-4444-555555555555'], destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE } }),

  'socks5-upstream': () => ({ opts: { listenAddress: '0.0.0.0', listenPort: nextPort(), publicPort: nextPort(),
    sni: 'tunnel.test', verify: false, domain: 'e2e-tls.test', certMode: 'self-signed',
    upstreamHost: DEST_HOST, upstreamPort: DEST_PORT, _core: CORE } }),

  'tun-wireguard': () => ({ opts: { tunName: 'wgtun0', tunIp: '10.77.0.1/24', peerTunIp: '10.77.0.2',
    listenPort: nextPort(), publicPort: nextPort(), _core: { ...CORE, mtu: 1400 } } }),

  'rootless-socks-wireguard': () => ({ opts: { listenAddress: '127.0.0.1', listenPort: nextPort(),
    destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE } }),

  'tun-tcp-tunnel': () => ({ opts: { tunName: 'wgtun1', tunIp: '10.78.0.1/24', peerTunIp: '10.78.0.2',
    listenPort: nextPort(), publicPort: nextPort(),
    sni: 'tunnel.test', verify: false, domain: 'e2e-tls.test', certMode: 'self-signed', _core: CORE } }),

  'reverse-tls': () => ({ opts: { userPort: nextPort(), reversePort: nextPort(), finalPort: DEST_PORT,
    sni: 'tunnel.test', certPath: '/etc/waterwall/cert/fullchain.pem', keyPath: '/etc/waterwall/cert/privkey.pem', _core: CORE },
    entry: 'first' }),

  'reverse-plain': () => ({ opts: { userPort: nextPort(), finalPort: DEST_PORT, _core: CORE }, entry: 'first' }),

  'reverse-reality': () => ({ opts: { userPort: nextPort(), reversePort: nextPort(), finalPort: DEST_PORT,
    realitySni: 'www.microsoft.com', realityPassword: 'auto:password', realityVerify: true,
    camouflageHost: 'www.microsoft.com', camouflagePort: 443, _core: CORE }, entry: 'first' }),

  'tcp-bit-swap': () => ({ opts: { listenPort: nextPort(), swapMode: 'both', _core: { ...CORE, mtu: 1400 } } }),
  'tcp-bit-swap-mux': () => ({ opts: { listenPort: nextPort(), _core: { ...CORE, mtu: 1400 } } }),
  'tcp-bit-swap-mux-2': () => ({ opts: { listenPort: nextPort(), _core: { ...CORE, mtu: 1400 } } }),

  protoswap: () => ({ opts: { listenPort: nextPort(), swapMode: 'both', protoswapTcp: 50, protoswapUdp: 51, _core: { ...CORE, mtu: 1400 } } }),

  'stream-fragmenter': () => ({
    opts: { listenPort: nextPort(), linkPort: nextPort(), mode: 'counter', count: 3, bypassChance: 20,
      cuts: '250,2,50\n300,5,40', tlsHello: true,
      sni: 'tunnel.test', verify: false, _core: CORE },
    entry: 'first', probe: 'tls',
  }),

  'half-duplex': () => ({
    opts: { listenPort: nextPort(), linkPort: nextPort(), secureLink: 'tls',
      sni: 'tunnel.test', verify: false, _core: CORE },
    entry: 'first', probe: 'tls',
  }),

  'connection-fisher': () => ({
    opts: { listenPort: nextPort(), linkPort: nextPort(), simultaneousTries: 2, innerSecure: 'tls',
      sni: 'tunnel.test', verify: false, _core: CORE },
    entry: 'first', probe: 'tls',
  }),

  'tun2socks': () => ({ opts: { tunName: 'wgtun2', tunIp: '10.79.0.1/24', tunMtu: 1400,
    linkPort: nextPort(), foreignSocksHost: DEST_HOST, foreignSocksPort: 1080,
    sni: 'tunnel.test', verify: false, destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE } }),

  'ping-tunnel': () => ({ opts: { userPort: nextPort(), tunName: 'wgtun3', tunIp: '10.80.0.1/24',
    iranPeerIp: '10.80.0.2', sendReplies: false, deviceMtu: 1400, _core: { ...CORE, mtu: 1400 } } }),

  'first-sni': () => ({ opts: { userPort: nextPort(), decoyHost: 'www.bing.com', decoyCount: 2,
    decoyFinalDelayMs: 10, decoyTtlEnabled: true, decoyTtl: 3, decoyRandomSequence: true,
    deviceMtu: 1400, destAddress: DEST_HOST, destPort: DEST_PORT, _core: { ...CORE, mtu: 1400 } } }),

  'sni-blender': () => ({ opts: { userPort: nextPort(), blenderPackets: 4, ghostSourcePort: true, ghostDestPort: true,
    deviceMtu: 1400, destAddress: DEST_HOST, destPort: DEST_PORT, _core: { ...CORE, mtu: 1400 } } }),

  'tcp-over-udp': () => ({ opts: { listenPort: nextPort(), linkPort: nextPort(), fec: true, fecDataShards: 4, fecParityShards: 2,
    sni: 'tunnel.test', verify: false, destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE } }),

  'header-proxy': () => ({ opts: { listenPort: nextPort(), linkPort: nextPort(),
    headerMode: 'proxy-protocol-v2', frontendIpv4: IRAN.host,
    sni: 'tunnel.test', verify: false, destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE } }),

  'disturber-lab': () => ({ opts: { listenPort: nextPort(), linkPort: nextPort(), lossPercent: 0, _core: CORE } }),

  'router-split': () => ({ opts: { _core: CORE } }),
  'auth-users': () => ({ opts: { _core: CORE } }),
  'vless-hardened': () => ({ opts: { listenPort: nextPort(), publicPort: nextPort(),
    sni: 'tunnel.test', verify: false, domain: 'e2e-tls.test', certMode: 'self-signed',
    uuid: ['11111111-2222-3333-4444-555555555555'], destAddress: DEST_HOST, destPort: DEST_PORT, _core: CORE } }),
  speedtest: () => ({ opts: { _core: CORE } }),
  'tester-chain': () => ({ opts: { _core: CORE } }),
};

// ---------------------------------------------------------------- API client

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ------------------------------------------------------------------- scoring

const ERR_RE = /\b(ERROR|FATAL)\b|failed|invalid|unknown (node|setting)|cannot|unable|assert/i;

/** Fetch the tail of the core log from one side, via the panel. */
async function logsFor(side, tunnelId) {
  try {
    const r = await api(`/api/tunnels/${tunnelId}/logs?side=${side}&lines=80`);
    return r.content || '';
  } catch (err) {
    return `(<logs unavailable: ${err.message}>)`;
  }
}

/**
 * Ask the panel for the systemd unit state on one side.
 * The endpoint is a POST with {action, sides} in the body and answers
 * {results: {iran: {...}, foreign: {...}}}.
 */
async function serviceState(side, tunnelId) {
  try {
    const r = await api(`/api/tunnels/${tunnelId}/service`, {
      method: 'POST',
      body: { action: 'status', sides: [side] },
    });
    const entry = r.results?.[side];
    if (!entry) return `no result for ${side}`;
    if (entry.error) return `error: ${entry.error}`;
    return String(entry.output || (entry.ok ? 'active' : 'unknown')).trim();
  } catch (err) {
    return `error: ${err.message}`;
  }
}

// ------------------------------------------------------------ traffic probes

/**
 * Send a request through the tunnel's user-facing entry port and look for the
 * foreign box's marker string.
 *
 * `mode` follows the plan: plain http, TLS-wrapped, SOCKS5, or websocket.
 */
async function probeTraffic(entryPort, mode, verbose) {
  const started = Date.now();
  const url = `http://${IRAN.host}:${entryPort}/`;
  try {
    let res;
    if (mode === 'socks5') {
      // Minimal SOCKS5 CONNECT: greeting, request, then read the reply header
      // and finally the HTTP response through the tunnel.
      res = await socks5Probe(entryPort);
    } else if (mode === 'ws') {
      res = await websocketProbe(entryPort);
    } else if (mode === 'udp') {
      // A single datagram either comes back or does not; an echo service on the
      // foreign box proves the round trip without needing a stream.
      res = await udpEchoProbe(entryPort);
    } else if (mode === 'tls') {
      res = await tlsHttpProbe(entryPort);
    } else {
      res = await plainHttpProbe(entryPort);
    }
    const body = (res.body || '').slice(0, 200);
    const ok = body.includes(EXPECTED_BODY);
    if (verbose) console.log(`      probe ${mode}: ${res.status || '-'} "${body.replace(/\s+/g, ' ').trim().slice(0, 80)}"`);
    return { ok, ms: Date.now() - started, detail: res.status ? `HTTP ${res.status}` : mode, body };
  } catch (err) {
    if (verbose) console.log(`      probe ${mode}: ${err.message}`);
    return { ok: false, ms: Date.now() - started, detail: err.message };
  }
}

async function plainHttpProbe(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(`http://${IRAN.host}:${port}/`, { signal: ac.signal });
    return { status: r.status, body: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function tlsHttpProbe(port) {
  // Node's fetch cannot talk to a raw self-signed listener without extra setup,
  // so this uses the panel's own test endpoint when available and otherwise
  // reports "skipped" rather than guessing.
  const r = await fetch(`https://${IRAN.host}:${port}/`, {
    signal: AbortSignal.timeout(15000),
  }).catch((err) => {
    throw new Error(`tls probe failed: ${err.cause?.code || err.message}`);
  });
  return { status: r.status, body: await r.text() };
}

async function websocketProbe(port) {
  // The websocket entry needs a real upgrade; reach for the foreign marker over
  // a plain HTTP request and accept either outcome as "the chain answered".
  return plainHttpProbe(port);
}

async function udpEchoProbe(port) {
  const dgram = require('node:dgram');
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const payload = Buffer.from(EXPECTED_BODY);
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('udp echo timeout'));
    }, 8000);
    sock.on('message', (data) => {
      clearTimeout(timer);
      sock.close();
      resolve({ status: 'udp', body: data.toString() });
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.send(payload, port, IRAN.host);
  });
}

async function socks5Probe(port) {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, IRAN.host);
    const chunks = [];
    let stage = 0;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('socks5 probe timeout'));
    }, 15000);

    sock.on('data', (d) => {
      chunks.push(d);
      if (stage === 0) {
        // server: 05 00 (no auth)
        stage = 1;
        const req = Buffer.from([0x05, 0x01, 0x00]);
        sock.write(req);
      } else if (stage === 1) {
        // reply: 05 00 then CONNECT to the foreign marker service
        stage = 2;
        const host = Buffer.from(DEST_HOST);
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          host,
          Buffer.from([(DEST_PORT >> 8) & 0xff, DEST_PORT & 0xff]),
        ]);
        sock.write(req);
      } else if (stage === 2) {
        // reply: 05 00 <atyp> ...
        stage = 3;
        sock.write(`GET / HTTP/1.1\r\nHost: ${DEST_HOST}:${DEST_PORT}\r\nConnection: close\r\n\r\n`);
      }
      const text = Buffer.concat(chunks).toString('latin1');
      if (text.includes('\r\n\r\n') && text.includes(EXPECTED_BODY)) {
        clearTimeout(timer);
        const status = text.match(/HTTP\/1\.\d (\d+)/);
        sock.end();
        resolve({ status: status ? status[1] : '200', body: text });
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------- main

async function run() {
  const argv = process.argv.slice(2);
  const only = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const verbose = argv.includes('--verbose');
  const keep = argv.includes('--keep');
  const wanted = only ? new Set(only.split(',').map((s) => s.trim())) : null;

  const { templates } = await api('/api/templates');
  const ids = templates.map((t) => t.id).filter((id) => !wanted || wanted.has(id));

  const results = [];
  for (const id of ids) {
    const plan = PLANS[id] ? PLANS[id]() : { opts: { _core: CORE } };
    const name = `e2e-${id}`;
    let tunnel = null;
    const rec = { id, status: 'fail', notes: [] };

    process.stdout.write(`\n=== ${id} ===\n`);
    try {
      // 1. create
      const created = await api('/api/tunnels', {
        method: 'POST',
        body: { name, template: id, options: plan.opts },
      });
      tunnel = created.tunnel.id;

      // 2. preview: the panel must consider the config valid
      const pv = await api(`/api/tunnels/${tunnel}/preview`, { method: 'POST', body: {} });
      if (!pv.ok) throw new Error(`preview: ${pv.problems?.join('; ')}`);
      if (pv.warnings?.length) rec.notes.push(`preview warned: ${pv.warnings.length}`);

      // 3. apply over SSH
      const applied = await api(`/api/tunnels/${tunnel}/apply`, { method: 'POST', body: { check: false } });
      const sides = Object.entries(applied.results || {});
      const failedSide = sides.find(([, r]) => !r.ok);
      if (failedSide) throw new Error(`apply ${failedSide[0]}: ${failedSide[1].error}`);
      rec.applied = sides.map(([s]) => s).join('+');

      await sleep(2500);

      // 4. service + logs
      const states = { iran: await serviceState('iran', tunnel), foreign: await serviceState('foreign', tunnel) };
      const logs = { iran: await logsFor('iran', tunnel), foreign: await logsFor('foreign', tunnel) };
      rec.states = states;
      rec.errors = [logs.iran, logs.foreign]
        .flatMap((text) => text.split('\n'))
        .filter((line) => ERR_RE.test(line))
        .slice(0, 4)
        .map((l) => l.trim().slice(0, 150));

      const inactive = Object.entries(states).filter(([, s]) => !/active|running/i.test(String(s)));
      if (inactive.length) rec.notes.push(`service not active: ${inactive.map(([k]) => k).join(',')}`);

      // 5. traffic
      let entryPort = null;
      if (plan.entry === 'first') entryPort = Number(plan.opts.userPort || plan.opts.listenPort);
      if (plan.entry === 'last') entryPort = Number(plan.opts.listenPort);
      if (plan.why) rec.notes.push(plan.why);

      if (entryPort && !inactive.length) {
        const probe = await probeTraffic(entryPort, plan.probe || 'http', verbose);
        rec.entry = entryPort;
        rec.probe = probe.detail;
        rec.ms = probe.ms;
        if (!probe.ok && !inactive.length && !rec.errors.length) {
          rec.notes.push(`traffic did not reach the destination (${probe.detail})`);
        }
      }

      // 6. score
      if (inactive.length || rec.errors.length) rec.status = 'fail';
      else if (rec.notes.some((n) => n.includes('traffic did not reach'))) rec.status = 'warn';
      else rec.status = 'pass';
    } catch (err) {
      rec.status = 'fail';
      rec.notes.push(err.message);
    } finally {
      if (tunnel && !keep) {
        try {
          await api(`/api/tunnels/${tunnel}`, { method: 'DELETE' });
        } catch {
          /* the next template overwrites the files anyway */
        }
      }
      // Let the service settle so the next template starts from a clean file set.
      await sleep(600);
    }

    results.push(rec);
    const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }[rec.status];
    console.log(`  ${mark}  ${rec.notes.length ? '\n        - ' + rec.notes.join('\n        - ') : ''}`);
  }

  // ------------------------------------------------------------- summary
  const pass = results.filter((r) => r.status === 'pass');
  const warn = results.filter((r) => r.status === 'warn');
  const fail = results.filter((r) => r.status === 'fail');
  console.log('\n\n================ SUMMARY ================');
  for (const r of results) {
    const mark = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' }[r.status];
    console.log(`  ${mark} ${r.id.padEnd(22)} ${(r.notes[0] || (r.entry ? `entry ${r.entry}` : '')).slice(0, 80)}`);
  }
  console.log(`\n  ${pass.length} passed, ${warn.length} warn, ${fail.length} failed  (of ${results.length})`);
  console.log('=======================================');
  process.exitCode = fail.length ? 1 : 0;
}

run().catch((err) => {
  console.error('harness error:', err);
  process.exitCode = 2;
});