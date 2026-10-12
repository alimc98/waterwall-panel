#!/usr/bin/env node
'use strict';

/**
 * WaterWall Agent
 * ---------------
 * Runs on the Iran and foreign servers. It polls the panel API for the
 * configuration assigned to its role, writes the files, restarts the
 * WaterWall service and reports health back to the panel.
 *
 * This is the piece that makes "change something in the UI -> it is applied on
 * both the Iran and the foreign server" work, without the panel ever needing a
 * long-lived SSH session.
 *
 * Usage:
 *   WW_PANEL_URL=https://panel.example.com \
 *   WW_AGENT_TOKEN=<server agent token> \
 *   node agent/agent.js
 *
 * Optional:
 *   WW_AGENT_INTERVAL=15      seconds between polls
 *   WW_WATERWALL_PATH=/opt/waterwall
 *   WW_SERVICE=waterwall
 *   WW_STATE=/var/lib/ww-agent/state.json
 *   WW_ROLE=iran|foreign      only needed when the token is ambiguous
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, exec } = require('node:child_process');

const PANEL_URL = (process.env.WW_PANEL_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const AGENT_TOKEN = process.env.WW_AGENT_TOKEN || '';
const INTERVAL = Number(process.env.WW_AGENT_INTERVAL || 15) * 1000;
const STATE_FILE = process.env.WW_STATE || '/var/lib/ww-agent/state.json';
const DRY_RUN = process.env.WW_DRY_RUN === '1';

if (!AGENT_TOKEN) {
  console.error('[ww-agent] WW_AGENT_TOKEN is required');
  process.exit(1);
}

const log = (...args) => console.log(`[ww-agent ${new Date().toISOString()}]`, ...args);

// ------------------------------------------------------------------ state
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { appliedHash: null, appliedAt: null, tunnels: [] };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log('could not persist state:', err.message);
  }
}

// ------------------------------------------------------------------- http
async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${PANEL_URL}${pathname}`, {
    method,
    headers: {
      'x-ww-agent-token': AGENT_TOKEN,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`panel returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ------------------------------------------------------------------ local
function run(cmd, args = []) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

async function serviceStatus(service) {
  const res = await run('systemctl', ['is-active', service]);
  const enabled = await run('systemctl', ['is-enabled', service]);
  return { active: res.stdout || 'unknown', enabled: enabled.stdout || 'unknown' };
}

/**
 * Read the version of the WaterWall core actually installed on this box.
 *
 * The panel needs this to tell the user when a tunnel needs a newer core than
 * the one on the server, instead of letting the service fail at startup.
 * Tries the flag spellings the core has used, then falls back to the binary's
 * embedded version string.
 *
 * The release archive names the binary "Waterwall" while many guides and
 * hand-made installs use "WaterWall". Linux paths are case sensitive, so try
 * both rather than assuming.
 */
async function waterwallVersion(basePath) {
  const candidates = ['Waterwall', 'WaterWall'].map((n) => `${basePath}/${n}`);
  const attempts = [['--version'], ['-v'], ['version'], ['--help']];
  for (const binary of candidates) {
    for (const args of attempts) {
      const res = await run(binary, args);
      const text = `${res.stdout || ''} ${res.stderr || ''}`;
      const m = text.match(/(\d+\.\d+\.\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

async function localFacts() {
  const serviceName = process.env.WW_SERVICE || 'waterwall';
  const [service, enabled, listeners, bootId, waterwallVersionText] = await Promise.all([
    serviceStatus(serviceName),
    run('systemctl', ['is-enabled', serviceName]),
    run('ss', ['-lntup']),
    run('sh', ['-c', 'cat /proc/sys/kernel/random/boot_id 2>/dev/null']),
    waterwallVersion(process.env.WW_WATERWALL_PATH || '/opt/waterwall'),
  ]);
  let publicIp = null;
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
    publicIp = await res.text();
  } catch {
    publicIp = null;
  }
  const parseListeners = (text) =>
    text
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length > 4)
      .map((c) => ({ proto: c[0], local: c[4], process: c.slice(6).join(' ') || null }))
      .filter((l) => l.local);

  return {
    hostname: os.hostname(),
    publicIp,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: os.cpus().length,
    memoryMb: Math.round(os.totalmem() / 1024 / 1024),
    uptimeSeconds: Math.round(os.uptime()),
    service: service.active || 'unknown',
    serviceEnabled: enabled.stdout || enabled.stderr || 'unknown',
    bootId: bootId.stdout,
    listeners: parseListeners(listeners.stdout).slice(0, 200),
    loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
    waterwallVersion: waterwallVersionText,
    agentVersion: '1.1.0',
  };
}

// ------------------------------------------------------------------ apply
function hashOf(bundles) {
  return crypto.createHash('sha256').update(JSON.stringify(bundles)).digest('hex');
}

function writeBundle(basePath, files) {
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(basePath, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Validate JSON before touching the running service
    if (rel.endsWith('.json')) JSON.parse(content);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) {
      written.push(rel);
      continue;
    }
    if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak.${Date.now()}`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
    written.push(rel);
  }
  return written;
}

async function apply(bundles, basePath) {
  const merged = {};
  for (const files of Object.values(bundles)) {
    for (const [rel, content] of Object.entries(files)) merged[rel] = content;
  }
  if (Object.keys(merged).length === 0) {
    return { changed: false, written: [], reason: 'no configuration assigned' };
  }
  const written = writeBundle(basePath, merged);
  if (DRY_RUN) {
    log('[dry-run] would write', written.join(', '));
    return { changed: true, written, dryRun: true };
  }
  const service = process.env.WW_SERVICE || 'waterwall';
  const restart = await run('systemctl', ['restart', service]);
  const status = await serviceStatus(service);
  if (!restart.ok) {
    return { changed: true, written, error: restart.stderr || 'systemctl restart failed', service: status };
  }
  return { changed: true, written, service: status };
}

// ------------------------------------------------------------------- main
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const payload = await api('/api/agent/config');
    const basePath = payload.server.waterwallPath || process.env.WW_WATERWALL_PATH || '/opt/waterwall';
    const hash = hashOf(payload.bundles);

    const state = readState();
    if (state.appliedHash !== hash) {
      log(`configuration changed (${payload.meta.length} tunnel(s)) — applying`);
      const result = await apply(payload.bundles, basePath);
      if (result.error) {
        log('apply failed:', result.error);
        await safeStatus(payload, basePath, { lastError: result.error, lastApply: result });
      } else {
        log('applied:', result.written.join(', '));
        writeState({ appliedHash: hash, appliedAt: new Date().toISOString(), tunnels: payload.meta });
        await safeStatus(payload, basePath, { lastError: null, lastApply: result });
      }
    } else {
      await safeStatus(payload, basePath, { lastError: state.lastError || null });
    }
  } catch (err) {
    log('poll failed:', err.message);
  } finally {
    ticking = false;
  }
}

async function safeStatus(payload, basePath, extra) {
  try {
    const facts = await localFacts();
    await api('/api/agent/status', {
      method: 'POST',
      body: {
        role: payload.server.role,
        serverId: payload.server.id,
        waterwallPath: basePath,
        revision: payload.revision,
        tunnels: payload.meta,
        ...facts,
        ...extra,
      },
    });
  } catch (err) {
    log('status report failed:', err.message);
  }
}

async function main() {
  log(`panel    : ${PANEL_URL}`);
  log(`interval : ${INTERVAL / 1000}s`);
  log(`state    : ${STATE_FILE}`);
  log(`dry-run  : ${DRY_RUN}`);
  await tick();
  setInterval(tick, INTERVAL);

  const shutdown = () => {
    log('bye');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[ww-agent] fatal:', err);
  process.exit(1);
});
