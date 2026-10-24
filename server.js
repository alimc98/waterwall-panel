'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { Store } = require('./lib/store');
const templates = require('./lib/templates');
const { buildBundle, renderClientConfig, resolveOptions, regenerateOptions } = require('./lib/build');
const { validateBundle, preprocessConfig } = require('./lib/generator');
const ssh = require('./lib/ssh');
const tests = require('./lib/tests');
const protoscan = require('./lib/protoscan');
const versions = require('./lib/versions');
const netcheck = require('./lib/netcheck');
const certs = require('./lib/certs');
const linkHealth = require('./lib/links');
const isolate = require('./lib/isolate');
const portfix = require('./lib/portfix');
const { Outbound } = require('./lib/outbound');
const { resolveTargets, targetsForSide, isTarget } = require('./lib/targets');
const { Router, sendJson, sendError, sendText, parseJsonBody, serveStatic, parseUrl } = require('./lib/http');
const { timingSafeEqual, readBody } = require('./lib/util');

const ROOT = __dirname;
const DATA_DIR = process.env.WW_PANEL_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.WW_PANEL_PORT || 8787);
/**
 * Loopback by default.
 *
 * This panel can run arbitrary commands on the registered servers (see
 * POST /api/servers/:id/ssh), so listening on every interface by default would
 * hand that capability to anyone who can reach the port. Set WW_PANEL_HOST to
 * expose it on purpose.
 */
const HOST = process.env.WW_PANEL_HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * The data directory holds the API token and any stored SSH passwords in plain
 * text — they have to be readable to be used, so the protection is the file
 * mode rather than encryption. 0700 keeps it to the panel's own user.
 */
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const store = new Store(DATA_DIR);
const certStore = new certs.CertStore(DATA_DIR);
/**
 * The panel's own way out.
 *
 * When the Iran box loses its international route, SSH to the foreign servers
 * dies with it. A local Xray client with a SOCKS inbound gives the panel a
 * different path (through a CDN, a relay, ...), and every ssh/scp the panel
 * spawns is routed through it while it runs.
 */
const outbound = new Outbound(DATA_DIR);
ssh.setProxyPortProvider(() => outbound.proxyPort());
const panelToken = process.env.WW_PANEL_TOKEN || store.getPanel().token;

// ---------------------------------------------------------------- helpers
function bearer(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  // `EventSource` cannot set request headers, so the event stream is the one
  // endpoint that has to accept the token as a query parameter. Accepting it
  // everywhere would write the token into access logs, browser history and
  // Referer headers on every other request, for no gain.
  const url = parseUrl(req);
  if (url.pathname === '/api/events') return url.searchParams.get('token') || '';
  return '';
}

function isPanelUser(req) {
  const token = bearer(req);
  if (!token) return false;
  return timingSafeEqual(token, panelToken);
}

function agentServer(req) {
  const token = req.headers['x-ww-agent-token'] || bearer(req);
  if (!token) return null;
  return store.listServers().find((s) => s.agentToken && timingSafeEqual(s.agentToken, token)) || null;
}

function guard(req, res) {
  if (isPanelUser(req)) return false;
  sendError(res, 401, 'unauthorized: missing or invalid API token');
  return true;
}

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

store.onLog((entry) => broadcast('log', entry));

/**
 * Every server a tunnel is deployed to. Reverse tunnels can name several exits,
 * so the foreign side is a list; `findServers` below keeps the old shape for the
 * routes that act on one server (logs, firewall hints, certificates).
 */
function findTargets(tunnel) {
  return resolveTargets(store.listServers(), tunnel);
}

function findServers(tunnel) {
  const { iran, foreign, relay } = findTargets(tunnel);
  return {
    iran,
    relay,
    foreign: foreign[0] || null,
  };
}

// ---------------------------------------------------------------- routes
const router = new Router();

router.get('/api/health', (req, res) => {
  sendJson(res, 200, { ok: true, version: require('./package.json').version, time: new Date().toISOString() });
});

router.get('/api/bootstrap', (req, res) => {
  if (guard(req, res)) return;
  sendJson(res, 200, {
    ok: true,
    token: panelToken,
    servers: store.listServers().map((s) => ({ ...s, sshPassword: s.sshPassword ? '***' : '' })),
    tunnels: store.listTunnels(),
    // Shipped with bootstrap so the outbound page renders its real state on the
    // first paint instead of flashing "off" while a second request is in flight.
    outbound: outbound.status(),
    templates: templates.catalog(),
    // Shipped with the catalog so the UI can show the target release and the
    // removed-settings list without a second request.
    versions: {
      current: versions.CURRENT,
      oldestSupported: versions.OLDEST_SUPPORTED,
      release: versions.RELEASE_NOTES[versions.CURRENT] || null,
      breaking: versions.REMOVED_SETTINGS.map((r) => ({
        key: r.key,
        nodes: r.nodes,
        since: r.since,
      })),
    },
  });
});

router.get('/api/templates', (req, res) => {
  if (guard(req, res)) return;
  sendJson(res, 200, { ok: true, templates: templates.catalog() });
});

router.get('/api/templates/:id', (req, res, ctx) => {
  if (guard(req, res)) return;
  const tpl = templates.get(ctx.params.id);
  if (!tpl) return sendError(res, 404, 'template not found');
  sendJson(res, 200, { ok: true, template: templates.catalogEntry(tpl) });
});

/**
 * Which WaterWall release the panel targets, what it changed, and what each
 * registered server is actually running.
 */
router.get('/api/versions', (req, res) => {
  if (guard(req, res)) return;
  const servers = store.listServers().map((s) => {
    const reported = versions.normalise(s.lastStatus?.waterwallVersion);
    const age = reported ? versions.cmp(reported, versions.CURRENT) : null;
    return {
      id: s.id,
      name: s.name,
      role: s.role,
      reported,
      current: reported === versions.CURRENT,
      older: age !== null && age < 0 ? true : false,
      belowSupported: reported ? versions.lt(reported, versions.OLDEST_SUPPORTED) : false,
      agentVersion: s.lastStatus?.agentVersion || null,
      lastSeen: s.lastSeen || null,
    };
  });

  sendJson(res, 200, {
    ok: true,
    current: versions.CURRENT,
    oldestSupported: versions.OLDEST_SUPPORTED,
    release: versions.RELEASE_NOTES[versions.CURRENT] || null,
    breaking: versions.REMOVED_SETTINGS.map((r) => ({
      key: r.key,
      nodes: r.nodes,
      since: r.since,
      reason: r.reason,
    })),
    features: versions.FEATURES,
    servers,
  });
});

// ---- servers -------------------------------------------------------------
router.get('/api/servers', (req, res) => {
  if (guard(req, res)) return;
  sendJson(res, 200, { ok: true, servers: store.listServers().map(redact) });
});

function redact(server) {
  return { ...server, sshPassword: server.sshPassword ? '***' : '' };
}

router.post('/api/servers', async (req, res) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  if (!body.host) return sendError(res, 400, 'host is required');
  const server = store.addServer(body);
  broadcast('servers', store.listServers().map(redact));
  sendJson(res, 201, { ok: true, server: redact(server) });
});

router.patch('/api/servers/:id', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  const server = store.updateServer(ctx.params.id, body);
  if (!server) return sendError(res, 404, 'server not found');
  broadcast('servers', store.listServers().map(redact));
  sendJson(res, 200, { ok: true, server: redact(server) });
});

router.delete('/api/servers/:id', (req, res, ctx) => {
  if (guard(req, res)) return;
  const ok = store.deleteServer(ctx.params.id);
  if (!ok) return sendError(res, 404, 'server not found');
  broadcast('servers', store.listServers().map(redact));
  sendJson(res, 200, { ok: true });
});

/**
 * Move a server one place up or down.
 *
 * A dedicated verb rather than a `priority` PATCH keeps the list contiguous:
 * the client never has to invent a number between two neighbours, and two
 * clients moving at once cannot end up with duplicate priorities.
 */
router.post('/api/servers/:id/move', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  const direction = body.direction === 'up' ? 'up' : body.direction === 'down' ? 'down' : null;
  if (!direction) return sendError(res, 400, 'direction must be up or down');
  const servers = store.moveServer(ctx.params.id, direction);
  if (!servers) return sendError(res, 404, 'server not found');
  broadcast('servers', servers.map(redact));
  sendJson(res, 200, { ok: true, servers: servers.map(redact) });
});

// ---- backup / restore ----------------------------------------------------
/**
 * Download the panel's own state.
 *
 * Driven through the browser rather than printed on screen: the file holds SSH
 * host lists and agent tokens, and `attachment` keeps it out of the page body.
 */
router.get('/api/backup', (req, res) => {
  if (guard(req, res)) return;
  const payload = { ...store.exportState(), outbound: outbound.exportSettings() };
  const body = JSON.stringify(payload, null, 2);
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'content-disposition': `attachment; filename="waterwall-backup-${stamp}.json"`,
    'cache-control': 'no-store',
  });
  res.end(body);
});

/** Replace the panel's servers, tunnels and outbound settings from a backup. */
router.post('/api/restore', async (req, res) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  try {
    // Validate and apply the outbound block first: importSettings parses the
    // Xray config and throws before writing anything, so a corrupt backup
    // cannot leave the server/tunnel lists already replaced.
    const restoredOutbound =
      body.outbound && typeof body.outbound === 'object' ? outbound.importSettings(body.outbound) : null;
    const counts = store.importState(body);
    broadcast('servers', store.listServers().map(redact));
    broadcast('tunnels', store.listTunnels());
    sendJson(res, 200, { ok: true, ...counts, outbound: restoredOutbound });
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

/**
 * Health of every tunnel that faces a CDN.
 *
 * The probe runs from the panel — the Iran box — so it measures the half that
 * fails silently: CDN edge to origin. A tunnel whose configs uploaded cleanly
 * still shows up as "قطع" here when the CDN cannot reach the origin port, which
 * is exactly the moment the operator needs to know.
 *
 * `?fresh=1` is the "check again" button; otherwise the short cache in
 * lib/links keeps a dashboard that re-renders on every event from turning into
 * a request loop against the CDN.
 */
router.get('/api/links', async (req, res) => {
  if (guard(req, res)) return;
  const fresh = parseUrl(req).searchParams.get('fresh') === '1';
  try {
    const rows = await linkHealth.checkTunnels(store.listTunnels(), { fresh });
    sendJson(res, 200, { ok: true, links: rows, outbound: outbound.status(), checkedAt: new Date().toISOString() });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

router.get('/api/servers/:id/probe', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const server = store.getServer(ctx.params.id);
  if (!server) return sendError(res, 404, 'server not found');
  const [info, service] = await Promise.all([ssh.hostInfo(server), ssh.serviceStatus(server)]);
  sendJson(res, 200, { ok: true, host: info, service });
});

/**
 * Run one command on a server.
 *
 * This is deliberately unrestricted — a panel that cannot run a command is not
 * much use when a service will not start — which makes it the highest-value
 * target on the port. Two things keep that in check: the listener defaults to
 * loopback, and every call is written to the audit log with the exact command,
 * so an unexpected one is visible after the fact rather than only in shell
 * history on a box the operator may not be watching.
 */
router.post('/api/servers/:id/ssh', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const server = store.getServer(ctx.params.id);
  if (!server) return sendError(res, 404, 'server not found');
  const body = await parseJsonBody(req);
  if (!body.command) return sendError(res, 400, 'command is required');
  const command = String(body.command);
  const result = await ssh.sshExec(server, command, { timeout: 60000 });
  store.log({ type: 'ssh.command', serverId: server.id, command, ok: !result.failed });
  sendJson(res, 200, { ok: !result.failed, ...result });
});

router.post('/api/servers/:id/service', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const server = store.getServer(ctx.params.id);
  if (!server) return sendError(res, 404, 'server not found');
  const body = await parseJsonBody(req);
  const action = body.action;
  if (!['start', 'stop', 'restart', 'status'].includes(action)) {
    return sendError(res, 400, 'action must be start|stop|restart|status');
  }
  const result = action === 'status' ? await ssh.serviceStatus(server) : await ssh.serviceAction(server, action);
  store.log({ type: 'service', serverId: server.id, action, result });
  sendJson(res, 200, { ok: true, result });
});

/**
 * Serve one server's service log, for the log viewer.
 *
 * The service name is constrained to systemd's own character set before it is
 * interpolated: this command runs as root on the target, so a name like
 * `foo; rm -rf /` must never reach the shell.
 */
router.get('/api/servers/:id/logs', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const server = store.getServer(ctx.params.id);
  if (!server) return sendError(res, 404, 'server not found');
  const lines = Math.max(20, Math.min(1000, Number(ctx.url.searchParams.get('lines')) || 200));
  const requested = String(ctx.url.searchParams.get('service') || server.serviceName || 'waterwall');
  const service = requested.replace(/[^A-Za-z0-9_.@:-]/g, '') || 'waterwall';
  // `systemctl status` is what the operator asked for: the unit description,
  // Loaded/Active lines, Main PID, Tasks, Memory and the cgroup tree, exactly
  // as the command prints them. The journal tail is fetched separately so the
  // status block keeps its own blank lines instead of being mixed into it.
  // Every command is `|| true` because `status` exits 3 for an inactive unit,
  // which sshExec would otherwise report as a failed read.
  const result = await ssh.sshExec(
    server,
    [
      `systemctl is-active ${service} 2>/dev/null || true`,
      `echo '__WW_ENABLED__'`,
      `systemctl is-enabled ${service} 2>/dev/null || true`,
      `echo '__WW_STATUS__'`,
      `systemctl status ${service} --no-pager --full -l -n 0 2>&1 || true`,
      `echo '__WW_LOG__'`,
      `journalctl -u ${service} -n ${lines} --no-pager 2>/dev/null | tail -n ${lines}`,
    ].join('; '),
    { timeout: 30000 },
  );
  const raw = result.stdout || '';
  // The three markers split stdout into exactly four chunks: is-active,
  // is-enabled, the status block, and the journal tail. Splitting in one go is
  // less error-prone than walking the string and tracking an offset.
  const segments = raw.split(/__WW_(?:ENABLED|STATUS|LOG)__/);
  const chunk = (i) => (segments[i] || '').replace(/^\r?\n/, '');
  const active = (segments[0] || '').trim().split(/\r?\n/)[0] || 'unknown';
  const enabledState = (segments[1] || '').trim().split(/\r?\n/)[0] || 'unknown';
  const statusText = chunk(2).replace(/\s+$/, '');
  const content = chunk(3);
  sendJson(res, 200, {
    ok: !result.failed,
    service,
    status: active,
    active,
    enabled: enabledState,
    statusText,
    content,
    error: result.failed ? (result.stderr || 'log command failed') : null,
  });
});

// ---- outbound (the panel's own internet path) ----------------------------
router.get('/api/outbound', (req, res) => {
  if (guard(req, res)) return;
  sendJson(res, 200, { ok: true, outbound: outbound.status() });
});

router.put('/api/outbound', async (req, res) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  try {
    const status = outbound.save(body);
    sendJson(res, 200, { ok: true, outbound: status });
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

router.post('/api/outbound/start', async (req, res) => {
  if (guard(req, res)) return;
  try {
    const status = await outbound.start();
    store.log({ type: 'outbound.start', port: status.port });
    broadcast('outbound', status);
    sendJson(res, 200, { ok: true, outbound: status });
  } catch (err) {
    sendError(res, 400, err.message, { outbound: outbound.status() });
  }
});

router.post('/api/outbound/stop', async (req, res) => {
  if (guard(req, res)) return;
  const status = await outbound.stop();
  store.log({ type: 'outbound.stop' });
  broadcast('outbound', status);
  sendJson(res, 200, { ok: true, outbound: status });
});

router.get('/api/outbound/logs', (req, res, ctx) => {
  if (guard(req, res)) return;
  const lines = Math.max(20, Math.min(1000, Number(ctx.url.searchParams.get('lines')) || 150));
  sendJson(res, 200, { ok: true, content: outbound.tailLog(lines) });
});

/** Prove the new path: fetch an IP through the SOCKS port, then SSH a foreign box. */
router.post('/api/outbound/test', async (req, res) => {
  if (guard(req, res)) return;
  const status = outbound.status();
  if (!status.running) return sendError(res, 400, 'outbound is not running');
  const curl = await ssh.run('curl', [
    '-sS',
    '-m',
    '12',
    '--socks5-hostname',
    `127.0.0.1:${status.port}`,
    'https://api.ipify.org',
  ]);
  const foreign = store.listServers().find((s) => s.role === 'foreign');
  let sshCheck = null;
  if (foreign) {
    const probe = await ssh.sshExec(foreign, 'echo tunnel-ok', { timeout: 20000 });
    sshCheck = {
      server: foreign.name,
      host: foreign.host,
      ok: !probe.failed,
      output: `${probe.stdout || ''}${probe.stderr || ''}`.trim().slice(0, 300),
    };
  }
  sendJson(res, 200, {
    ok: !curl.failed,
    internet: { ok: !curl.failed, ip: (curl.stdout || '').trim(), error: curl.failed ? curl.stderr.trim() : null },
    ssh: sshCheck,
  });
});

// ---- tunnels -------------------------------------------------------------
// ---- certificates ---------------------------------------------------------
/** Everything the panel knows about certificates, read back from the servers. */
router.get('/api/certs', async (req, res) => {
  if (guard(req, res)) return;
  const servers = store.listServers();
  const rows = [];
  for (const server of servers) {
    const live = await certs.inspect((sv, c, o) => ssh.sshExec(sv, c, o), server).catch((err) => ({
      present: false,
      error: err.message,
    }));
    const known = live.present && live.commonName ? certStore.find(live.commonName) : null;
    rows.push({
      server: { id: server.id, name: server.name, role: server.role, host: server.host },
      live: { ...live, status: live.notAfter ? certs.statusOf(live) : 'missing', daysLeft: certs.daysUntil(live.notAfter) },
      record: known || null,
    });
  }
  sendJson(res, 200, { ok: true, certPath: certs.CERT_PATH, keyPath: certs.KEY_PATH, servers: rows });
});

/** Issue or renew a certificate on one server. */
router.post('/api/certs', async (req, res) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  const servers = store.listServers();
  const server =
    servers.find((x) => x.id === body.serverId) ||
    servers.find((x) => x.role === (body.role || 'foreign')) ||
    null;
  if (!server) return sendError(res, 400, 'no server to issue on; pass serverId or register one with that role');

  const domain = certs.normaliseDomain(body.domain);
  const check = certs.validateDomain(domain);
  if (!check.ok) return sendError(res, 400, check.error);

  const mode = ['auto', 'letsencrypt', 'self-signed', 'none'].includes(body.mode) ? body.mode : 'auto';
  if (mode === 'none') return sendError(res, 400, 'mode "none" issues nothing');

  const result = await certs.ensure((sv, c, o) => ssh.sshExec(sv, c, o), server, {
    domain,
    mode,
    email: String(body.email || '').trim(),
    serverIp: body.serverIp || server.host,
    force: body.force !== false,
  });

  if (!result.ok) {
    store.log({ type: 'cert.fail', serverId: server.id, domain, error: result.error });
    return sendJson(res, 200, { ok: false, error: result.error, reason: result.reason || null, domain });
  }

  const record = certStore.put({
    domain: result.domain,
    serverId: server.id,
    serverName: server.name,
    mode: result.mode,
    commonName: result.commonName,
    issuer: result.issuer || null,
    notAfter: result.notAfter,
    fingerprint: result.fingerprint,
    certPath: result.certPath,
    keyPath: result.keyPath,
    fallbackNote: result.fallbackNote || null,
  });
  store.log({ type: 'cert.issue', serverId: server.id, domain, mode: result.mode });
  sendJson(res, 200, { ok: true, cert: { ...record, status: certs.statusOf(record), daysLeft: certs.daysUntil(record.notAfter) } });
});

router.delete('/api/certs/:id', (req, res, ctx) => {
  if (guard(req, res)) return;
  const removed = certStore.remove(ctx.params.id);
  if (!removed) return sendError(res, 404, 'certificate record not found');
  // The file itself is left alone on purpose: deleting it out from under a
  // running tunnel would take the service down, and the user may still be using it.
  sendJson(res, 200, { ok: true, note: 'رکورد حذف شد؛ فایل گواهی روی سرور دست‌نخورده باقی ماند.' });
});

router.get('/api/tunnels', (req, res) => {
  if (guard(req, res)) return;
  sendJson(res, 200, { ok: true, tunnels: store.listTunnels() });
});

router.post('/api/tunnels', async (req, res) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  if (!templates.get(body.template)) return sendError(res, 400, `unknown template: ${body.template}`);
  // Resolve generated secrets (UUID, passwords, WireGuard keypairs) once, at
  // save time, so both servers keep using the same values afterwards.
  body.options = resolveOptions(body.template, body.options || {}, body);
  const tunnel = store.addTunnel(body);
  broadcast('tunnels', store.listTunnels());
  sendJson(res, 201, { ok: true, tunnel });
});

router.get('/api/tunnels/:id', (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  sendJson(res, 200, { ok: true, tunnel });
});

router.patch('/api/tunnels/:id', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  if (body.template && !templates.get(body.template)) {
    return sendError(res, 400, `unknown template: ${body.template}`);
  }
  const tunnel = store.updateTunnel(ctx.params.id, body);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  if (body.options || body.template) {
    const merged = { ...tunnel, ...body };
    store.updateTunnel(tunnel.id, {
      options: resolveOptions(merged.template, merged.options || {}, merged),
    });
  }
  const updated = store.getTunnel(tunnel.id);
  broadcast('tunnels', store.listTunnels());
  sendJson(res, 200, { ok: true, tunnel: updated });
});

/** Roll new values for every auto-generated secret (UUID, passwords, keys). */
router.post('/api/tunnels/:id/regenerate', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const stripped = regenerateOptions(tunnel.template, tunnel.options);
  const fresh = resolveOptions(tunnel.template, stripped, tunnel);
  const updated = store.updateTunnel(tunnel.id, { options: fresh });
  store.log({ type: 'tunnel.regenerate', tunnelId: tunnel.id });
  sendJson(res, 200, { ok: true, tunnel: updated });
});

/**
 * Take a deleted tunnel off the servers it was deployed to.
 *
 * Deleting the row used to leave everything else behind: the generated
 * config, the core.json that lists it and a running systemd unit. The tunnel
 * kept serving users after it vanished from the panel, and came back after a
 * reboot. Cleanup removes this tunnel's config plus its backups, then rewrites
 * core.json to name only the configs that still exist on that server:
 *
 *  - another tunnel sharing the same install path keeps its config and the
 *    unit is restarted into the pruned core.json,
 *  - when nothing is left to load, core.json is removed and the unit is
 *    stopped and disabled, so nothing can bring the deleted tunnel back.
 *
 * A server this tunnel never actually ran on is left untouched. Stopping or
 * restarting it would drop the connections of whatever it *is* serving — a
 * tunnel that names several exits only ever deployed to some of them.
 *
 * A server that cannot be reached is reported per server and the row is still
 * deleted: refusing to delete would strand a tunnel whose server is gone, and
 * the panel would keep listing something the operator already removed.
 */
async function removeTunnelFromServer(server, files) {
  const base = server.waterwallPath || '/opt/waterwall';
  const removed = await ssh.removeTunnelConfigs(server, base, files);
  if (!removed.ok) return { ok: false, error: removed.error };

  const corePath = path.posix.join(base, 'core.json');
  const read = await ssh.readRemoteFile(server, corePath);
  let core = null;
  if (read.ok && read.content && read.content.trim()) {
    try {
      core = JSON.parse(read.content);
    } catch {
      core = null;
    }
  }

  const result = { ok: true, deleted: removed.deleted };
  const stopService = async () => {
    const stop = await ssh.serviceAction(server, 'stop');
    await ssh.sshExec(server, `systemctl disable ${ssh.shellQuote(server.serviceName || 'waterwall')} 2>&1`);
    result.service = `stopped (${(stop.output || '').split(/\r?\n/)[0] || 'inactive'})`;
  };

  if (!core || !Array.isArray(core.configs)) {
    // Nothing loads these files without a core.json. Only touch the unit when
    // this server really held the tunnel.
    if (removed.deleted.length) await stopService();
    else result.service = 'not deployed here';
    return result;
  }

  // A config that is no longer on disk must not stay in the boot list. This
  // also drops entries left by earlier deletions, which is the only place the
  // panel ever notices them.
  const kept = core.configs.filter((entry) => {
    const rel = String(entry).replace(/^\.?\//, '');
    return removed.after.includes(path.posix.basename(rel));
  });

  if (kept.length === core.configs.length) {
    // core.json never named this tunnel, so the running service is fine: the
    // files (if any) are gone and there is nothing left to reload.
    result.core = 'unchanged';
    if (!removed.deleted.length) result.service = 'not deployed here';
    return result;
  }
  if (!kept.length) {
    await ssh.sshExec(server, `rm -f ${ssh.shellQuote(corePath)} ${ssh.shellQuote(corePath)}.bak.*`);
    await stopService();
    result.core = 'removed';
    return result;
  }
  const written = await ssh.uploadFiles(
    server,
    { 'core.json': `${JSON.stringify({ ...core, configs: kept }, null, 2)}\n` },
    base,
  );
  if (!written.ok) return { ok: false, error: written.error, deleted: result.deleted };
  const restart = await ssh.serviceAction(server, 'restart');
  result.core = 'pruned';
  result.kept = kept;
  result.service = restart.ok ? 'restarted' : restart.output;
  return result;
}

async function removeTunnelFromServers(tunnel) {
  const bundle = buildBundle(store, tunnel);
  const targets = findTargets(tunnel);
  const rows = [];
  for (const side of Object.keys(bundle.bundles || {})) {
    const files = Object.keys(bundle.bundles[side] || {});
    if (!files.length) continue;
    for (const server of targetsForSide(targets, side)) {
      // Sequential on purpose: a deletion is a handful of servers and each
      // one runs a few ssh commands; firing them in parallel buys nothing and
      // makes a failure harder to attribute.
      rows.push({
        side,
        server: server.name,
        host: server.host,
        ...(await removeTunnelFromServer(server, files)),
      });
    }
  }
  return rows;
}

router.delete('/api/tunnels/:id', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const cleanup = await removeTunnelFromServers(tunnel);
  const ok = store.deleteTunnel(ctx.params.id);
  if (!ok) return sendError(res, 404, 'tunnel not found');
  // Isolated service records exist only for this tunnel. Removing the tunnel's
  // configs above already stopped their units; drop the now-unreferenced
  // records so they do not linger as fake "servers" in the panel.
  const remaining = store.listTunnels();
  const referenced = new Set();
  for (const other of remaining) {
    const t = other?.targetServers || {};
    for (const id of [t.iran, t.relay, ...(Array.isArray(t.foreign) ? t.foreign : [t.foreign])]) {
      if (id) referenced.add(id);
    }
  }
  for (const record of store.listServers()) {
    if (record.clonedFor === tunnel.id && !referenced.has(record.id)) store.deleteServer(record.id);
  }
  const failed = cleanup.filter((row) => !row.ok);
  // A failed cleanup is the interesting case: it means a file and a service
  // are still on a box. Keep it in the audit log so it can be repeated by hand.
  if (failed.length) store.log({ type: 'tunnel.cleanup.failed', tunnelId: tunnel.id, cleanup });
  broadcast('tunnels', store.listTunnels());
  sendJson(res, 200, { ok: true, cleanup, failed });
});

/** Generate + validate the WaterWall files without touching any server. */
router.post('/api/tunnels/:id/preview', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const result = buildBundle(store, tunnel);
  sendJson(res, 200, { ok: true, ...result });
});

/** Deploy the generated bundle over SSH to the selected servers. */
router.post('/api/tunnels/:id/apply', async (req, res, ctx) => {
  if (guard(req, res)) return;
  let tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const body = await parseJsonBody(req);
  let bundle = buildBundle(store, tunnel);
  if (bundle.problems.length) {
    return sendError(res, 400, 'generated configuration is invalid', { problems: bundle.problems });
  }
  // Only sides the template actually produced can be deployed. Defaulting to
  // the bundle keys (rather than a hard-coded pair) is what makes a two-sided
  // reverse tunnel, a single-sided middle relay and a three-sided relay tunnel
  // all work without a flag.
  const sides = Array.isArray(body.sides) && body.sides.length ? body.sides : Object.keys(bundle.bundles);
  const deploySides = sides.filter((side) => bundle.bundles[side]);
  /**
   * Another enabled tunnel already using one of these server records means the
   * two would share a unit and a core.json: whichever applies last wins, and
   * the other disappears on the next restart. Give this tunnel its own service
   * on the same host before writing anything.
   */
  const isolation = body.dryRun
    ? {
        ok: true,
        plan: isolate.isolationPlan(store, tunnel, deploySides),
        clones: [],
        skipped: [],
        changed: false,
      }
    : await isolate.isolateTargets(store, tunnel, deploySides, ssh);
  if (!body.dryRun && isolation.changed) {
    tunnel = store.updateTunnel(tunnel.id, { targetServers: isolation.targets });
    broadcast('servers', store.listServers().map(redact));
    broadcast('tunnels', store.listTunnels());
    const rebuilt = buildBundle(store, tunnel);
    if (rebuilt.problems.length) {
      return sendError(res, 400, 'generated configuration is invalid after service isolation', {
        problems: rebuilt.problems,
        isolation,
      });
    }
    bundle = rebuilt;
  }
  /**
   * A separate unit solves the core.json overwrite, but not the bind: two
   * WaterWall processes on one box cannot share port 443, and the second one
   * silently fails to come up. Move the newcomer to a free port before it is
   * written, so the tunnel works instead of replacing the first one.
   */
  const portFix = await resolvePorts(store, tunnel, deploySides, bundle, ssh);
  if (portFix.changed && !body.dryRun) {
    tunnel = store.updateTunnel(tunnel.id, { options: { ...(tunnel.options || {}), ...portFix.options } });
    broadcast('tunnels', store.listTunnels());
    const rebuilt = buildBundle(store, tunnel);
    if (rebuilt.problems.length) {
      return sendError(res, 400, 'generated configuration is invalid after port allocation', {
        problems: rebuilt.problems,
        isolation,
        portFix,
      });
    }
    bundle = rebuilt;
  }
  const targets = findTargets(tunnel);
  const servers = {
    iran: targets.iran,
    relay: targets.relay,
    foreign: targets.foreign[0] || null,
  };
  const blocked = new Map(isolation.skipped.map((row) => [`${row.side}:${row.server.id}`, row.reason]));

  // A tunnel with a domain gets its certificate handled before anything is
  // written, so the service never starts against a missing or expired file.
  let certificate = null;
  if (body.checkCertificates !== false) {
    // The certificate belongs on whichever side actually holds TlsServer. Most
    // templates put it on the exit box, but the reverse templates put it on the
    // Iran box, and picking the wrong one would install a certificate where
    // nothing reads it.
    const certSide = tlsServerSide(bundle);
    const target = servers[certSide] || servers.iran || servers.foreign;
    const domain = certs.normaliseDomain(tunnel.options?.domain);
    if (target && domain && certs.validateDomain(domain).ok) {
      const mode = tunnel.options?.certMode || 'auto';
      if (mode !== 'none') {
        // The tunnel's own cert paths are what its generated config reads, so
        // the certificate has to land exactly there. Issuing to the global
        // default while the config points at a per-tunnel path is a service
        // that refuses to start with "No such file or directory".
        const result = await certs.ensure((sv, c, o) => ssh.sshExec(sv, c, o), target, {
          domain,
          mode,
          email: tunnel.options?.certEmail || '',
          serverIp: target.host,
          certPath: tunnel.options?.certPath || undefined,
          keyPath: tunnel.options?.keyPath || undefined,
        });
        if (result.ok) {
          certificate = certStore.put({
            domain: result.domain,
            serverId: target.id,
            serverName: target.name,
            mode: result.mode,
            commonName: result.commonName,
            issuer: result.issuer || null,
            notAfter: result.notAfter,
            fingerprint: result.fingerprint,
            certPath: result.certPath,
            keyPath: result.keyPath,
          });
        } else {
          // Failing to issue is not fatal on its own: a certificate may already
          // be installed by hand at the configured path.
          certificate = { error: result.error, reason: result.reason || null, fatal: false };
        }
      }
    }
  }

  const results = {};
  for (const side of sides) {
    const files = bundle.bundles[side];
    if (!files) {
      results[side] = { ok: false, error: 'template does not produce a config for this side' };
      continue;
    }
    // A reverse tunnel can have a whole fleet of exits; every one of them gets
    // the same foreign bundle, because the config names the Iran entry, not the
    // exit's own address. The relay side is a single middle server.
    const fleet = targetsForSide(targets, side);
    if (!fleet.length) {
      results[side] = { ok: false, error: `no server registered for side "${side}"` };
      continue;
    }
    if (body.dryRun) {
      results[side] = {
        ok: true,
        dryRun: true,
        files: Object.keys(files),
        ...(fleet.length > 1 ? { servers: fleet.map((s) => ({ ok: true, server: s.name })) } : {}),
      };
      continue;
    }
    const per = [];
    for (const server of fleet) {
      const why = blocked.get(`${side}:${server.id}`);
      if (why) {
        per.push({ ok: false, server: server.name, error: why });
        continue;
      }
      const uploaded = await ssh.uploadFiles(server, files, server.waterwallPath);
      if (!uploaded.ok) {
        per.push({ ok: false, server: server.name, error: uploaded.error });
        continue;
      }
      let svc = { ok: true, output: 'restart skipped' };
      if (body.restart !== false) {
        // Cleanup disables a unit it empties, so make sure a redeploy turns it
        // back on: a tunnel that only restarts would vanish on the next reboot.
        const svcName = server.serviceName || 'waterwall';
        await ssh.sshExec(server, `systemctl enable ${ssh.shellQuote(svcName)} 2>&1`);
        svc = await ssh.serviceAction(server, 'restart');
      }
      per.push({ ok: true, server: server.name, uploaded: Object.keys(files), service: svc });
    }
    results[side] =
      per.length === 1
        ? per[0]
        : {
            ok: per.every((p) => p.ok),
            servers: per,
            uploaded: [...new Set(per.flatMap((p) => p.uploaded || []))],
            service: per.map((p) => `${p.server}: ${p.service?.output || p.error || ''}`).join('\n'),
          };
  }
  store.log({ type: 'tunnel.apply', tunnelId: tunnel.id, sides, results });
  broadcast('tunnels', store.listTunnels());

  // A tunnel can upload cleanly and still be dead because the far side's
  // firewall never let the link port through. Measuring it here turns a silent
  // failure into an explicit, actionable message instead of a config hunt.
  let reachability = null;
  if (body.check !== false && bundle.bundles.foreign && !bundle.bundles.relay && servers.iran && servers.foreign) {
    try {
      reachability = await netcheck.checkTunnel((s, c, o) => ssh.sshExec(s, c, o), servers, {
        link: listenerPort(bundle, 'foreign'),
        user: listenerPort(bundle, 'iran'),
      });
    } catch (err) {
      reachability = { error: err.message, problems: [] };
    }
  }

  sendJson(res, 200, {
    ok: Object.values(results).every((r) => r.ok),
    results,
    reachability,
    certificate,
    isolation,
    portFix,
  });
});

/**
 * Move the listening ports of a tunnel out of the way of its neighbours.
 *
 * Two tunnels can share a box and still have to share the numbers their
 * clients dial. The check is per side and per server: a side may point at a
 * fleet of exits, and the port has to be free on every one of them.
 *
 * The result is reported back so the UI can say what moved and why. A dry
 * run reports the same thing without touching the store or the servers.
 *
 * @returns {Promise<{changed: boolean, options: Object, moved: Array, problems: Array}>}
 */
async function resolvePorts(store, tunnel, sides, bundle, ssh) {
  const result = { changed: false, options: { ...(tunnel.options || {}) }, moved: [], problems: [] };
  const targets = findTargets(tunnel);
  for (const side of sides) {
    const fleet = targetsForSide(targets, side);
    if (!fleet.length) continue;
    for (const server of fleet) {
      const fix = await portfix.resolvePortConflicts(store, tunnel, server, side, bundle, ssh);
      if (fix.moved.length) {
        Object.assign(result.options, fix.options);
        result.moved.push(...fix.moved.map((m) => ({ ...m, server: server.name })));
        result.changed = true;
      }
    }
  }
  // Only the keys that actually moved are reported, so the caller can merge
  // them into the stored options without touching anything else.
  if (result.changed) {
    const movedKeys = new Set(result.moved.map((m) => m.key));
    for (const key of Object.keys(result.options)) {
      if (!movedKeys.has(key)) delete result.options[key];
    }
  }
  return result;
}

/**
 * Which side of a built bundle holds the TlsServer node.
 *
 * The certificate goes there. Most templates put it on the foreign box, but
 * the reverse templates put the server side on the Iran box instead, so the side is
 * decided by reading the node types rather than assuming.
 */
function tlsServerSide(bundle) {
  for (const side of Object.keys(bundle.bundles || {})) {
    for (const [file, text] of Object.entries(bundle.bundles?.[side] || {})) {
      if (!file.startsWith('configs/')) continue;
      try {
        const parsed = JSON.parse(preprocessConfig(text).text);
        const has = (parsed.nodes || []).some((n) => n.type === 'TlsServer');
        if (has) return side;
      } catch {
        /* an unparseable config is already reported by validateBundle */
      }
    }
  }
  return 'foreign';
}

/**
 * The first port a side listens on for connections.
 *
 * Read straight out of the emitted JSON so the reported port can never drift
 * from what the template actually produced.
 */
function listenerPort(bundle, side) {
  for (const [file, text] of Object.entries(bundle.bundles?.[side] || {})) {
    if (!file.startsWith('configs/')) continue;
    let parsed;
    try {
      parsed = JSON.parse(preprocessConfig(text).text);
    } catch {
      continue;
    }
    for (const node of parsed.nodes || []) {
      if (!/Listener$/.test(String(node.type || ''))) continue;
      const port = node.settings?.port;
      if (port !== undefined && /^\d+$/.test(String(port))) return Number(port);
    }
  }
  return null;
}

/**
 * Apply the firewall rule the reachability check suggested.
 *
 * Narrow on purpose: only scoped `ufw allow` rules the panel itself derived are
 * accepted, so this endpoint cannot be used to run arbitrary commands on a live
 * host or to open a port to the world.
 */
router.post('/api/tunnels/:id/fix-firewall', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const body = await parseJsonBody(req);
  const servers = findServers(tunnel);
  const command = String(body.command || '');
  if (!command) return sendError(res, 400, 'command is required');

  // Work out which server the rule belongs to from its own shape.
  const target =
    [servers.iran, servers.relay, servers.foreign].find((srv) => srv && command.includes(srv.host)) || servers.foreign;
  if (!target) return sendError(res, 400, 'no server to apply this to');

  const result = await netcheck.applyFirewallFix((s, c, o) => ssh.sshExec(s, c, o), target, command);
  if (!result.ok) return sendError(res, 400, result.error);
  store.log({ type: 'firewall.fix', tunnelId: tunnel.id, command, output: result.output });
  sendJson(res, 200, { ok: true, command, server: target.name, output: result.output });
});

router.post('/api/tunnels/:id/service', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const body = await parseJsonBody(req);
  const targets = findTargets(tunnel);
  const defaultSides = ['iran', 'relay', 'foreign'].filter((side) => targetsForSide(targets, side).length);
  const sides = Array.isArray(body.sides) && body.sides.length ? body.sides : defaultSides;
  const results = {};
  for (const side of sides) {
    const fleet = targetsForSide(targets, side);
    if (!fleet.length) {
      results[side] = { ok: false, error: 'server not found' };
      continue;
    }
    const per = [];
    for (const server of fleet) {
      per.push({ server: server.name, ...(await ssh.serviceAction(server, body.action || 'restart')) });
    }
    results[side] =
      per.length === 1
        ? per[0]
        : {
            ok: per.every((p) => p.ok),
            servers: per,
            output: per.map((p) => `${p.server}: ${p.output || p.error || ''}`).join('\n'),
          };
  }
  sendJson(res, 200, { ok: true, results });
});

router.get('/api/tunnels/:id/logs', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const url = parseUrl(req);
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const servers = findServers(tunnel);
  const side = url.searchParams.get('side') || 'foreign';
  const server = servers[side];
  if (!server) return sendError(res, 404, 'server not found');
  const file = url.searchParams.get('file') || 'log/core.log';
  const remote = path.posix.join(server.waterwallPath, file);
  const out = await ssh.tailRemoteFile(server, remote, Number(url.searchParams.get('lines') || 200));
  sendJson(res, 200, { ok: out.ok, content: out.content, error: out.error });
});

/** Client-side connection details (links, JSON, shell export). */
router.get('/api/tunnels/:id/client', (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  sendJson(res, 200, { ok: true, ...renderClientConfig(store, tunnel) });
});

router.post('/api/preview', async (req, res) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  if (!templates.get(body.template)) return sendError(res, 400, 'unknown template');
  const fake = {
    id: 'preview',
    name: body.name || 'preview',
    template: body.template,
    options: body.options || {},
    targetServers: body.targetServers || {},
  };
  const result = buildBundle(store, fake);
  sendJson(res, 200, { ok: true, ...result });
});

// ---- user management (auth-users templates) ------------------------------
/**
 * Users live inside the tunnel options and are rendered into `users.json` for
 * the AuthenticationServer. These endpoints are what an external bot or your
 * own dashboard can call to add/remove users; the agent then ships the file to
 * both servers.
 */
router.get('/api/tunnels/:id/users', (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  sendJson(res, 200, { ok: true, users: tunnel.options?.users || [] });
});

router.post('/api/tunnels/:id/users', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const body = await parseJsonBody(req);
  if (!body.username) return sendError(res, 400, 'username is required');
  const users = [...(tunnel.options?.users || [])];
  if (users.some((u) => u.username === body.username)) {
    return sendError(res, 409, `user "${body.username}" already exists`);
  }
  users.push({
    username: body.username,
    password: body.password || require('node:crypto').randomBytes(12).toString('base64url'),
    enabled: body.enabled !== false,
    ...(body.deviceLimit ? { deviceLimit: Number(body.deviceLimit) } : {}),
    ...(body.totalLimitGb ? { totalLimitGb: Number(body.totalLimitGb) } : {}),
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
  });
  store.updateTunnel(tunnel.id, { options: { ...tunnel.options, users } });
  store.log({ type: 'user.add', tunnelId: tunnel.id, username: body.username });
  sendJson(res, 201, { ok: true, users });
});

router.patch('/api/tunnels/:id/users/:username', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const body = await parseJsonBody(req);
  const users = [...(tunnel.options?.users || [])];
  const idx = users.findIndex((u) => u.username === ctx.params.username);
  if (idx === -1) return sendError(res, 404, 'user not found');
  users[idx] = { ...users[idx], ...body, username: users[idx].username };
  store.updateTunnel(tunnel.id, { options: { ...tunnel.options, users } });
  store.log({ type: 'user.update', tunnelId: tunnel.id, username: ctx.params.username });
  sendJson(res, 200, { ok: true, users });
});

router.delete('/api/tunnels/:id/users/:username', (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const users = (tunnel.options?.users || []).filter((u) => u.username !== ctx.params.username);
  if (users.length === (tunnel.options?.users || []).length) {
    return sendError(res, 404, 'user not found');
  }
  store.updateTunnel(tunnel.id, { options: { ...tunnel.options, users } });
  store.log({ type: 'user.delete', tunnelId: tunnel.id, username: ctx.params.username });
  sendJson(res, 200, { ok: true, users });
});

router.post('/api/validate', async (req, res) => {
  if (guard(req, res)) return;
  const raw = await readBody(req);
  let text;
  try {
    text = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendError(res, 400, 'request body must be JSON of the form {"files":{...}}');
  }
  const problems = validateBundle(text.files || {});
  sendJson(res, 200, { ok: problems.length === 0, problems });
});

// ---- protocol-number probing --------------------------------------------
/**
 * Which IPv4 Protocol numbers actually survive the route? A number can be
 * legal in a `protoswap` config and still be filtered in transit, so the panel
 * sends real packets and reports which ones get through.
 */
router.post('/api/test/protocols', async (req, res) => {
  if (guard(req, res)) return;
  const body = await parseJsonBody(req);
  const raw = Array.isArray(body.protocols)
    ? body.protocols
    : String(body.protocols || '')
        .split(/[\s,]+/)
        .filter(Boolean);
  const protocols = raw.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!protocols.length) return sendError(res, 400, 'protocols must be a list of numbers between 0 and 255');
  if (!body.dst) return sendError(res, 400, 'dst is required (the destination server address)');

  const result = await protoscan.probeProtocols({
    protocols,
    dst: body.dst,
    src: body.src || null,
    timeout: Math.max(200, Math.min(10000, Number(body.timeout) || 1500)),
    attempts: Math.max(1, Math.min(5, Number(body.attempts) || 2)),
  });
  store.log({ type: 'test', kind: 'protocols', dst: body.dst, open: result.summary?.open });
  sendJson(res, 200, { ok: result.ok, kind: 'protocols', ...result });
});

/** Per-tunnel helper: pull the probe list straight from the tunnel definition. */
router.post('/api/tunnels/:id/protocol-scan', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const built = buildBundle(store, tunnel);
  const probe = built.probe || templates.get(tunnel.template)?.probe;
  if (!probe) return sendError(res, 400, 'this template has no protocol probe defined');

  const servers = store.listServers();
  const from = servers.find((s) => s.role === 'iran');
  const to = servers.find((s) => s.role === 'foreign');
  if (!to) return sendError(res, 400, 'register a foreign server first');

  const body = await parseJsonBody(req);
  const result = await protoscan.probeProtocols({
    protocols: body.protocols || probe.protocols,
    dst: to.host,
    src: body.src || from?.host || null,
    timeout: body.timeout || probe.timeoutMs,
    attempts: body.attempts || 2,
  });

  // Mark which numbers the tunnel already uses, so the report is actionable.
  const used = new Set();
  const options = built.options || {};
  if (Number.isInteger(options.protoswapTcp)) used.add(options.protoswapTcp);
  if (Number.isInteger(options.protoswapUdp)) used.add(options.protoswapUdp);
  for (const r of result.results || []) r.inUseByTunnel = used.has(r.protocol);

  store.log({ type: 'protocol-scan', tunnelId: tunnel.id, open: result.summary?.open });
  sendJson(res, 200, { ok: result.ok, kind: 'protocols', ...result, used: [...used] });
});

// ---- connectivity tests --------------------------------------------------
const TEST_ROUTES = {
  tcp: tests.tcpProbe,
  socks: tests.socks5HttpTest,
  ping: tests.icmpPing,
  traceroute: tests.traceRoute,
  speed: tests.speedTest,
  udp: tests.udpDnsTest,
  resolve: tests.resolveHost,
};

for (const [name, fn] of Object.entries(TEST_ROUTES)) {
  router.post(`/api/test/${name}`, async (req, res) => {
    if (guard(req, res)) return;
    const body = await parseJsonBody(req);
    if (name === 'udp' && !body.server) body.server = '1.1.1.1';
    if (name === 'resolve' && !body.host) return sendError(res, 400, 'host is required');
    // icmpPing / traceRoute / tcpProbe / udpDnsTest take their argument under
    // `host`; keep the other tools on their own dedicated keys.
    if (['ping', 'traceroute'].includes(name) && body.target && !body.host) body.host = body.target;
    const started = Date.now();
    try {
      const result = await fn(body);
      store.log({ type: 'test', kind: name, input: body, ok: result.ok });
      sendJson(res, 200, { ok: true, kind: name, ms: Date.now() - started, result });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });
}

// ---- agent plane ---------------------------------------------------------
/**
 * WaterWall agents (Iran + foreign) pull their configuration from here and
 * push status back. This is what makes "change in the panel -> applied on both
 * servers" work without the panel ever holding an SSH session open.
 */
router.get('/api/agent/config', (req, res) => {
  const server = agentServer(req);
  if (!server) return sendError(res, 401, 'agent token not recognised');
  const url = parseUrl(req);
  const tunnelIds = url.searchParams.get('tunnels');
  const all = store.listTunnels().filter((t) => t.enabled);
  const selected = tunnelIds
    ? all.filter((t) => tunnelIds.split(',').includes(t.id))
    : all;
  const bundles = {};
  const meta = [];
  for (const tunnel of selected) {
    const targets = resolveTargets(store.listServers(), tunnel);
    // Only the servers this tunnel actually points at get its bundle. The old
    // role-wide behaviour stays for tunnels with no explicit targets.
    if (!isTarget(targets, tunnel, server, templates.get(tunnel.template)?.sides)) continue;
    const built = buildBundle(store, tunnel);
    if (!built.bundles[server.role]) continue;
    bundles[tunnel.id] = built.bundles[server.role];
    meta.push({ id: tunnel.id, name: tunnel.name, template: tunnel.template, updatedAt: tunnel.updatedAt });
  }
  sendJson(res, 200, {
    ok: true,
    server: { id: server.id, role: server.role, waterwallPath: server.waterwallPath, serviceName: server.serviceName },
    revision: store.getPanel().revision || 0,
    bundles,
    meta,
  });
});

router.post('/api/agent/status', async (req, res) => {
  const server = agentServer(req);
  if (!server) return sendError(res, 401, 'agent token not recognised');
  const body = await parseJsonBody(req);
  const updated = store.reportStatus(server.id, body);
  broadcast('server-status', { serverId: server.id, status: body });
  sendJson(res, 200, { ok: true, server: redact(updated) });
});

// ---- events --------------------------------------------------------------
router.get('/api/events', (req, res) => {
  if (guard(req, res)) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`retry: 3000\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ---------------------------------------------------------------- server
/**
 * Response headers applied to every reply.
 *
 * The panel is a same-origin single-page app with no third-party assets, so the
 * policy can be strict: scripts and styles come from this origin only. Inline
 * style attributes are still needed (the UI sets them while rendering), which
 * is why style-src keeps 'unsafe-inline' while script-src does not.
 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  // The event stream authenticates with a token in the query string, so a
  // Referer leak would be a credential leak.
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

const server = require('node:http').createServer(async (req, res) => {
  const url = parseUrl(req);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    if (url.pathname.startsWith('/api/')) {
      const match = router.match(req.method, url.pathname);
      if (!match) return sendError(res, 404, `no route for ${req.method} ${url.pathname}`);
      return await match.handler(req, res, { params: match.params, url });
    }
    if (serveStatic(res, PUBLIC_DIR, url.pathname)) return;
    // Fetched by servers, not browsers: the agent itself, the one-file
    // installer, and the offline installer kept at the repo root.
    const DOWNLOADS = {
      '/agent.js': () => path.join(ROOT, 'agent', 'agent.js'),
      '/install-agent.sh': () => path.join(PUBLIC_DIR, 'install-agent.sh'),
      '/install.sh': () => path.join(ROOT, 'install.sh'),
      '/panel-install.sh': () => path.join(ROOT, 'panel-install.sh'),
    };
    if (DOWNLOADS[url.pathname]) {
      const source = DOWNLOADS[url.pathname]();
      let body;
      try {
        body = fs.readFileSync(source);
      } catch {
        return sendError(res, 404, `${url.pathname} is not present in this checkout`);
      }
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': body.length,
        'content-disposition': `attachment; filename="${path.basename(source)}"`,
      });
      return res.end(body);
    }
    // SPA fallback
    if (serveStatic(res, PUBLIC_DIR, '/index.html')) return;
    sendError(res, 404, 'not found');
  } catch (err) {
    console.error('[panel]', err);
    // A handler may mark a failure as the client's fault (malformed JSON, bad
    // URL escape); reporting those as 500 blames the server for the request.
    if (!res.headersSent) sendError(res, err.statusCode || 500, err.message || 'internal error');
  }
});

server.listen(PORT, HOST, () => {
  const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1' || HOST === '[::1]';
  console.log('');
  console.log('  WaterWall Panel');
  console.log('  ─────────────────────────────────────────');
  console.log(`  UI / API : http://${HOST}:${PORT}`);
  // Only advertise addresses a reader could actually reach. Listing LAN URLs
  // while bound to loopback sends them to a connection refused.
  if (!isLoopback) {
    Object.values(require('node:os').networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address)
      .forEach((ip) => console.log(`  LAN      : http://${ip}:${PORT}`));
  }
  console.log(`  API token: ${panelToken}`);
  console.log(`  Data dir : ${DATA_DIR}`);
  console.log('');
  const withPassword = store.listServers().filter((s) => s.sshPassword);
  if (withPassword.length) {
    console.log(`  ⚠  ${withPassword.length} server(s) store an SSH password in plain text in`);
    console.log('     the data directory. Key authentication avoids storing it at all.');
    console.log('');
  }
  if (!isLoopback) {
    console.log(`  ⚠  Listening on ${HOST}. This panel can run commands on your servers,`);
    console.log('     so anyone who can reach this port can too. Bind to 127.0.0.1');
    console.log('     and use a tunnel unless you have deliberately opened it.');
    console.log('');
  }
  console.log('  Open the URL in a browser and sign in with the API token.');
  console.log('');
  // Saved outbound stays enabled across restarts, so reconnect it once the
  // panel is listening (and after the SSH proxy provider is wired above).
  outbound.autostart().catch(() => {});
});

// systemd sends SIGTERM on restart. Kill the Xray child instead of leaving it
// parented to init, but keep `enabled` so the next boot brings it back.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    outbound.kill();
    process.exit(0);
  });
}
