'use strict';

/**
 * Build every template's config for the live harness.
 *
 * The harness runs both halves of a link at once inside Linux network
 * namespaces on one machine. Namespaces give each side its own loopback, its
 * own ports and its own TUN devices, so the configs hardly need rewriting —
 * only the addresses have to point at the test topology:
 *
 *   host       2001:db8::1  (no)   ->  10.200.0.1   the test service lives here
 *   namespace  wwiran              ->  10.200.0.2   the Iran side runs here
 *   namespace  wwforeign           ->  10.200.0.3   the other side runs here
 *
 * `iranHost` / `foreignHost` are injected into every bundle from the server
 * records, so choosing these addresses is enough to make the two halves find
 * each other. Everything the templates dial as a *destination* is redirected
 * to the test service instead of example.com.
 *
 *   node test/live/generate.js [templateId]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const templates = require('../../lib/templates');
const { buildBundle } = require('../../lib/build');
const { Store } = require('../../lib/store');
const { preprocessConfig } = require('../../lib/generator');
const SPEC = require('./spec');

const IRAN_HOST = '10.200.0.2';
const FOREIGN_HOST = '10.200.0.3';
const SVC_HOST = '10.200.0.1';
const TCP_ECHO = 9001;
const HTTP_PORT = 9002;

// A throwaway certificate path: the live server has a real certificate at the
// production path and the harness must never touch it.
const CERT = '/root/wwtest/cert/fullchain.pem';
const KEY = '/root/wwtest/cert/privkey.pem';

// The one account the harness provisions when a template asks for users.
const TEST_USER = 'wwtest';
const TEST_PASSWORD = 'wwtest-pass';

const OUT = path.join(__dirname, 'out');
const only = process.argv[2];

/** The first listener in a config is the one a user connects to. */
function entryListener(cfg) {
  for (const n of cfg.nodes || []) {
    if (!/Listener$/.test(n.type)) continue;
    const port = Number(n.settings && n.settings.port);
    if (!port) continue;
    return { node: n.name, port, type: n.type };
  }
  return null;
}

function build(tpl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwlive-'));
  const store = new Store(dataDir);
  store.addServer({ id: 'srv-iran', name: 'Iran', role: 'iran', host: IRAN_HOST });
  store.addServer({ id: 'srv-foreign', name: 'Foreign', role: 'foreign', host: FOREIGN_HOST });

  // Anything a template can dial as a real destination is pointed at the test
  // service. Ports are left exactly as the template ships them: namespaces
  // make a collision between the two sides impossible.
  const overrides = {};
  const fields = tpl.fields || [];
  const has = (k) => fields.some((f) => f.key === k);
  if (has('destAddress')) overrides.destAddress = SVC_HOST;
  if (has('destPort')) overrides.destPort = TCP_ECHO;
  if (has('localServiceAddress')) overrides.localServiceAddress = SVC_HOST;
  if (has('finalAddress')) overrides.finalAddress = SVC_HOST;
  if (has('finalPort')) overrides.finalPort = TCP_ECHO;
  if (has('verify')) overrides.verify = false;
  if (has('certPath')) overrides.certPath = CERT;
  if (has('keyPath')) overrides.keyPath = KEY;
  // A fresh, isolated TUN name per template *and per field*: a packet template
  // that carries two chains (the mirrored direction, a second exit) creates two
  // TUN devices, and two devices cannot share one name — the core refuses the
  // second with "Device or resource busy" and the whole config is dead. Reusing
  // names across templates also keeps a half-torn-down run from blocking the
  // next one. Names are local to a host, so the two servers never need to agree
  // on one.
  ['deviceName', 'iranTunName', 'foreignTunName', 'tunName'].forEach((key, slot) => {
    if (has(key)) overrides[key] = `wt${slot}${templates.ALL.indexOf(tpl) % 10}`;
  });
  if (has('iranTunIp')) overrides.iranTunIp = '10.10.0.1/24';
  if (has('foreignTunIp')) overrides.foreignTunIp = '10.10.0.2/24';
  // A template that asks for accounts must get one, or the server has nothing
  // to authenticate against and every probe is refused.
  if (has('users')) overrides.users = [{ username: TEST_USER, password: TEST_PASSWORD }];

  let tunnel = store.addTunnel({ name: tpl.id, template: tpl.id, options: overrides });
  let res = buildBundle(store, tunnel);
  if (res.optionsPatch) {
    tunnel = store.updateTunnel(tunnel.id, { options: { ...tunnel.options, ...res.optionsPatch } });
    res = buildBundle(store, tunnel);
  }
  return res;
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const summary = [];

  for (const tpl of templates.ALL) {
    if (only && tpl.id !== only) continue;
    const spec = SPEC[tpl.id] || { entry: null, reason: 'no test plan for this template' };
    const res = build(tpl);

    const entry = { iran: null, foreign: null };
    const nodes = { iran: [], foreign: [] };
    for (const side of ['iran', 'foreign']) {
      const files = res.bundles[side] || {};
      const dir = path.join(OUT, tpl.id, side);
      fs.mkdirSync(path.join(dir, 'log'), { recursive: true });
      for (const [file, text] of Object.entries(files)) {
        const target = path.join(dir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
      }
      for (const [file, text] of Object.entries(files)) {
        if (!file.startsWith('configs/')) continue;
        let cfg;
        try {
          cfg = JSON.parse(preprocessConfig(text).text);
        } catch {
          continue;
        }
        for (const n of cfg.nodes || []) nodes[side].push(n.type);
        const found = entryListener(cfg);
        // The foreign side of a tunnelled template listens for the tunnel, not
        // for users, so only trust it when the template says both sides are
        // independent forwarders.
        if (found && (side === 'iran' || spec.entry === 'both')) entry[side] = found;
      }
    }

    const tests = [];
    if (spec.entry === 'both') {
      for (const side of ['iran', 'foreign']) {
        if (entry[side]) tests.push({ side, proto: spec.proto, host: side === 'iran' ? IRAN_HOST : FOREIGN_HOST, port: entry[side].port });
      }
    } else if (spec.entry === 'iran' && entry.iran) {
      tests.push({ side: 'iran', proto: spec.proto, host: IRAN_HOST, port: entry.iran.port });
    } else if (spec.entry === 'iran-ns') {
      tests.push({ side: 'iran', proto: spec.proto, host: IRAN_HOST, port: entry.iran ? entry.iran.port : 0, inNamespace: true });
    }
    // The probe needs the same pair the config was built with.
    if (spec.proto === 'socks5-auth') {
      for (const t of tests) t.creds = `${TEST_USER}:${TEST_PASSWORD}`;
    }

    const plan = {
      id: tpl.id,
      titleFa: tpl.titleFa || tpl.title || tpl.id,
      tests,
      loadOnly: tests.length === 0 && spec.proto !== 'log',
      reason: spec.reason || null,
      logPattern: spec.logPattern || null,
      // Templates that are slow to become ready for reasons of their own (an
      // authentication client pulls its user table on its own schedule) raise
      // the budget the harness gives their probes and log checks.
      probeSeconds: spec.probeSeconds || null,
      logSeconds: spec.logSeconds || null,
      nodes,
      problems: res.problems,
      target: `${SVC_HOST}:${TCP_ECHO}`,
      httpTarget: `${SVC_HOST}:${HTTP_PORT}`,
    };
    fs.writeFileSync(path.join(OUT, tpl.id, 'plan.json'), JSON.stringify(plan, null, 2));

    summary.push({ id: tpl.id, tests: tests.map((t) => `${t.proto}:${t.port}`).join(',') || '-', problems: res.problems.length });
  }

  console.log(JSON.stringify(summary, null, 1));
  console.log(`\nwrote ${OUT}`);
}

main();
