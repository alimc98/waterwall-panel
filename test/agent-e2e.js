'use strict';
/**
 * The path the deployment actually uses: panel over HTTP -> agent -> files.
 *
 * No servers and no SSH. A panel is started on a loopback port with a seeded
 * data directory (two servers, one enabled tunnel), the agent is run once
 * against it in dry-run mode, and the result is checked on both sides: the
 * files the agent would write have to be exactly the files the panel built and
 * the live servers are already running, and the panel has to end up with a
 * status report for that agent.
 *
 * This is the part of a live deployment that is easy to get wrong and hard to
 * see: the agent authenticates with its *server* token (not the panel token),
 * the panel decides which tunnels belong to it, and a bundle that differs by
 * one byte from what is running restarts WaterWall on a production box.
 *
 *   node test/agent-e2e.js
 */

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const { Store } = require(path.join(repo, 'lib', 'store'));
const { buildBundle } = require(path.join(repo, 'lib', 'build'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-agent-e2e-'));
const dataDir = path.join(tmp, 'panel-data');
const wwDir = path.join(tmp, 'waterwall');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wwDir, { recursive: true });

const TOKEN = 'panel-token-for-the-agent-test-0123456789abcdef';
const AGENT_TOKEN = 'iran-agent-token-0123456789abcdef';

const store = new Store(dataDir);
store.addServer({
  id: 'srv-iran',
  name: 'Iran',
  role: 'iran',
  host: '192.0.2.10',
  waterwallPath: wwDir,
  serviceName: 'waterwall',
  agentToken: AGENT_TOKEN,
});
store.addServer({ id: 'srv-foreign', name: 'Foreign', role: 'foreign', host: '192.0.2.20', waterwallPath: wwDir });
const tunnel = store.addTunnel({
  name: 'agent-e2e',
  template: 'tcp-forward',
  enabled: true,
  options: { listenPort: 8081, destAddress: '192.0.2.20', destPort: 9001 },
});
// The token comes from the environment (WW_PANEL_TOKEN), exactly as it does in
// the systemd unit the installer writes; panel.json is not needed for this.

const expected = buildBundle(store, store.getTunnel(tunnel.id));
assert.strictEqual(expected.ok, true, `the panel must build the tunnel: ${expected.problems.join('; ')}`);

let panel;
let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`  ✗ ${label}: ${err.message}`);
  }
};

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function panelUp(port) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/servers`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (r.status === 401) return false;
      if (r.ok) return true;
    } catch {
      // not listening yet
    }
    await waitFor(250);
  }
  return false;
}

async function main() {
  panel = spawn(process.execPath, [path.join(repo, 'server.js')], {
    env: {
      ...process.env,
      WW_PANEL_HOST: '127.0.0.1',
      WW_PANEL_PORT: '8791',
      WW_PANEL_TOKEN: TOKEN,
      WW_PANEL_DATA: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let panelLog = '';
  panel.stdout.on('data', (d) => (panelLog += d));
  panel.stderr.on('data', (d) => (panelLog += d));

  const up = await panelUp('8791');
  check('the panel starts and accepts its token', () => assert.strictEqual(up, true, panelLog.slice(-400)));

  const agentEnv = {
    ...process.env,
    WW_PANEL_URL: 'http://127.0.0.1:8791',
    WW_AGENT_TOKEN: AGENT_TOKEN,
    WW_AGENT_INTERVAL: '600',
    WW_STATE: path.join(tmp, 'agent-state.json'),
    WW_WATERWALL_PATH: wwDir,
    WW_DRY_RUN: '1',
  };
  const agent = spawn(process.execPath, [path.join(repo, 'agent', 'agent.js')], {
    env: agentEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let agentLog = '';
  agent.stdout.on('data', (d) => (agentLog += d));
  agent.stderr.on('data', (d) => (agentLog += d));

  // The first tick fetches, (dry-)applies and reports status.
  for (let i = 0; i < 40 && !/applied:/.test(agentLog); i += 1) await waitFor(250);

  check('the agent authenticates with its own token and applies', () =>
    assert.match(agentLog, /applied:/, agentLog.slice(-400)));

  check('dry-run names every file of the tunnel', () => {
    for (const rel of Object.keys(expected.bundles.iran)) {
      assert.ok(agentLog.includes(rel), `${rel} was not part of the apply: ${agentLog.slice(-300)}`);
    }
  });

  // Status has to land on the panel: this is what fills lastSeen/lastStatus.
  let seen = null;
  for (let i = 0; i < 40 && !seen; i += 1) {
    await waitFor(250);
    const servers = new Store(dataDir).listServers();
    seen = servers.find((s) => s.id === 'srv-iran' && s.lastSeen);
  }
  check('the panel records the status report', () => {
    assert.ok(seen?.lastSeen, 'no lastSeen on the server');
    assert.strictEqual(seen.lastStatus?.service, 'unknown', 'the service state must be reported');
    assert.ok(String(seen.lastStatus?.waterwallPath || '').length > 0, 'the waterwall path must round-trip');
  });

  // A wrong token must not be able to fetch anything.
  const bad = await fetch('http://127.0.0.1:8791/api/agent/config', { headers: { 'x-ww-agent-token': 'nope' } });
  check('an unknown agent token is rejected', () => assert.strictEqual(bad.status, 401));

  // The bundle the agent gets has to be the one the running boxes already have:
  // a byte of drift here means a production restart the moment an agent is
  // installed. Both sides are compared through the same code path the agent
  // uses (JSON over the API).
  const fetched = await fetch('http://127.0.0.1:8791/api/agent/config', { headers: { 'x-ww-agent-token': AGENT_TOKEN } });
  check('the agent endpoint answers its own token', () => assert.strictEqual(fetched.status, 200));
  const payload = await fetched.json();
  check('the bundle is exactly what the panel builds', () =>
    assert.deepStrictEqual(payload.bundles[tunnel.id], expected.bundles.iran));

  agent.kill();
  panel.kill();
  await waitFor(300);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\n  agent path: ok' : `\n  agent path: ${failures} failure(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('agent e2e crashed:', err);
  panel?.kill();
  process.exitCode = 2;
});
