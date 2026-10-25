'use strict';

/**
 * The agent token must not travel with the server list.
 *
 * The token authorises the agent plane: `GET /api/agent/config` hands over
 * every tunnel's generated configuration, and `POST /api/agent/status`
 * writes to the server's record. It is a credential, so the ordinary server
 * list — which the whole UI reads — must not carry it.
 *
 * The operator still has to be able to read it to install the agent, so it
 * is fetched on its own, from a dedicated endpoint.
 *
 * This starts the real server on a random port and talks to it over HTTP.
 */

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the panel on a free port with its own data directory. */
async function startPanel() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwpanel-http-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      WW_PANEL_DATA: dataDir,
      WW_PANEL_PORT: String(port),
      WW_PANEL_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/api/bootstrap`, {
        headers: { authorization: 'Bearer probe' },
      });
      if (res.status < 500) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  const token = fs.readFileSync(path.join(dataDir, 'panel.json'), 'utf8');
  const panelToken = JSON.parse(token).token;
  return {
    child,
    base,
    dataDir,
    panelToken,
    output: () => output,
    stop: () => {
      try { child.kill(); } catch { /* already gone */ }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function api(base, panelToken, pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${panelToken}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function tests(ok, bad, failures) {
  const check = async (label, fn) => {
    try {
      await fn();
      ok(label);
    } catch (err) {
      bad(label);
      failures.push(`${label}: ${err && err.message ? err.message : err}`);
      console.log(`      ${err && err.message ? err.message : err}`);
    }
  };

  const panel = await startPanel();
  try {
    let serverId = '';

    await check('the agent token is not in the server list', async () => {
      const created = await api(panel.base, panel.panelToken, '/api/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Token box',
          role: 'foreign',
          host: '198.51.100.9',
          sshPassword: 'hunter2',
        }),
      });
      assert.strictEqual(created.status, 201, 'the server was not created');
      serverId = created.body.server.id;

      const list = await api(panel.base, panel.panelToken, '/api/servers');
      assert.strictEqual(list.status, 200);
      const row = list.body.servers.find((s) => s.id === serverId);
      assert.ok(row, 'the server is missing from the list');
      assert.strictEqual(
        row.agentToken,
        undefined,
        'the agent token travelled with the server list',
      );
      assert.strictEqual(row.sshPassword, '***', 'the SSH password was not masked');
      // The record on disk still has both: masking is for the wire only.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(panel.dataDir, 'servers.json'), 'utf8'),
      );
      const stored = onDisk.find((s) => s.id === serverId);
      assert.ok(stored.agentToken, 'the token was not kept on disk');
      assert.strictEqual(stored.sshPassword, 'hunter2', 'the SSH password was not kept on disk');
    });

    await check('the agent token is fetched on its own', async () => {
      const res = await api(panel.base, panel.panelToken, `/api/servers/${serverId}/agent-token`);
      assert.strictEqual(res.status, 200, `the endpoint answered ${res.status}`);
      assert.ok(res.body.agentToken, 'no token was returned');
      assert.ok(res.body.agentToken.length >= 16, 'the token looks too short');
    });

    await check('the agent token endpoint needs the panel token', async () => {
      const res = await fetch(`${panel.base}/api/servers/${serverId}/agent-token`);
      assert.strictEqual(res.status, 401, `the endpoint answered ${res.status} without a token`);
    });

    await check('an unknown server has no agent token', async () => {
      const res = await api(panel.base, panel.panelToken, '/api/servers/nope/agent-token');
      assert.strictEqual(res.status, 404, `the endpoint answered ${res.status}`);
    });

    await check('the agent token really is the agent credential', async () => {
      // The token the list hides has to be the one the agent plane accepts —
      // otherwise the agent could not connect and the masking would be hiding
      // a token nobody can use.
      const res = await api(panel.base, panel.panelToken, `/api/servers/${serverId}/agent-token`);
      const token = res.body.agentToken;

      const withToken = await fetch(`${panel.base}/api/agent/config`, {
        headers: { 'x-ww-agent-token': token },
      });
      assert.strictEqual(withToken.status, 200, 'the agent plane rejected the token');

      const withoutToken = await fetch(`${panel.base}/api/agent/config`);
      assert.strictEqual(withoutToken.status, 401, 'the agent plane accepted no token at all');
    });
  } finally {
    panel.stop();
  }
}

module.exports = { tests };
