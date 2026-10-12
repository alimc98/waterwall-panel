'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { Store } = require('./lib/store');
const templates = require('./lib/templates');
const { buildBundle, renderClientConfig, resolveOptions, regenerateOptions } = require('./lib/build');
const { validateBundle } = require('./lib/generator');
const ssh = require('./lib/ssh');
const tests = require('./lib/tests');
const protoscan = require('./lib/protoscan');
const { Router, sendJson, sendError, sendText, parseJsonBody, serveStatic, parseUrl } = require('./lib/http');
const { timingSafeEqual, readBody } = require('./lib/util');

const ROOT = __dirname;
const DATA_DIR = process.env.WW_PANEL_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.WW_PANEL_PORT || 8787);
const HOST = process.env.WW_PANEL_HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new Store(DATA_DIR);
const panelToken = process.env.WW_PANEL_TOKEN || store.getPanel().token;

// ---------------------------------------------------------------- helpers
function bearer(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const url = parseUrl(req);
  return url.searchParams.get('token') || '';
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

function findServers(tunnel) {
  const servers = store.listServers();
  const pick = (role, explicitId) => {
    if (explicitId) return servers.find((s) => s.id === explicitId) || null;
    return servers.find((s) => s.role === role) || null;
  };
  return {
    iran: pick('iran', tunnel?.targetServers?.iran),
    foreign: pick('foreign', tunnel?.targetServers?.foreign),
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
    templates: templates.catalog(),
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

router.get('/api/servers/:id/probe', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const server = store.getServer(ctx.params.id);
  if (!server) return sendError(res, 404, 'server not found');
  const [info, service] = await Promise.all([ssh.hostInfo(server), ssh.serviceStatus(server)]);
  sendJson(res, 200, { ok: true, host: info, service });
});

router.post('/api/servers/:id/ssh', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const server = store.getServer(ctx.params.id);
  if (!server) return sendError(res, 404, 'server not found');
  const body = await parseJsonBody(req);
  if (!body.command) return sendError(res, 400, 'command is required');
  const result = await ssh.sshExec(server, body.command, { timeout: 60000 });
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

// ---- tunnels -------------------------------------------------------------
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

router.delete('/api/tunnels/:id', (req, res, ctx) => {
  if (guard(req, res)) return;
  const ok = store.deleteTunnel(ctx.params.id);
  if (!ok) return sendError(res, 404, 'tunnel not found');
  broadcast('tunnels', store.listTunnels());
  sendJson(res, 200, { ok: true });
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
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const body = await parseJsonBody(req);
  const sides = body.sides || ['iran', 'foreign'];
  const bundle = buildBundle(store, tunnel);
  if (bundle.problems.length) {
    return sendError(res, 400, 'generated configuration is invalid', { problems: bundle.problems });
  }
  const servers = findServers(tunnel);
  const results = {};
  for (const side of sides) {
    const server = servers[side];
    const files = bundle.bundles[side];
    if (!files) {
      results[side] = { ok: false, error: 'template does not produce a config for this side' };
      continue;
    }
    if (!server) {
      results[side] = { ok: false, error: `no server registered with role "${side}"` };
      continue;
    }
    if (body.dryRun) {
      results[side] = { ok: true, dryRun: true, files: Object.keys(files) };
      continue;
    }
    const uploaded = await ssh.uploadFiles(server, files, server.waterwallPath);
    if (!uploaded.ok) {
      results[side] = { ok: false, error: uploaded.error };
      continue;
    }
    const svc = body.restart === false ? { ok: true, output: 'restart skipped' } : await ssh.serviceAction(server, 'restart');
    results[side] = { ok: true, uploaded: Object.keys(files), service: svc };
  }
  store.log({ type: 'tunnel.apply', tunnelId: tunnel.id, sides, results });
  broadcast('tunnels', store.listTunnels());
  sendJson(res, 200, { ok: Object.values(results).every((r) => r.ok), results });
});

router.post('/api/tunnels/:id/service', async (req, res, ctx) => {
  if (guard(req, res)) return;
  const tunnel = store.getTunnel(ctx.params.id);
  if (!tunnel) return sendError(res, 404, 'tunnel not found');
  const body = await parseJsonBody(req);
  const servers = findServers(tunnel);
  const results = {};
  for (const side of body.sides || ['iran', 'foreign']) {
    const server = servers[side];
    if (!server) {
      results[side] = { ok: false, error: 'server not found' };
      continue;
    }
    results[side] = await ssh.serviceAction(server, body.action || 'restart');
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
  for (const tunnel of selected) {
    const built = buildBundle(store, tunnel);
    if (built.bundles[server.role]) bundles[tunnel.id] = built.bundles[server.role];
  }
  sendJson(res, 200, {
    ok: true,
    server: { id: server.id, role: server.role, waterwallPath: server.waterwallPath, serviceName: server.serviceName },
    revision: store.getPanel().revision || 0,
    bundles,
    meta: selected.map((t) => ({ id: t.id, name: t.name, template: t.template, updatedAt: t.updatedAt })),
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
const server = require('node:http').createServer(async (req, res) => {
  const url = parseUrl(req);
  try {
    if (url.pathname.startsWith('/api/')) {
      const match = router.match(req.method, url.pathname);
      if (!match) return sendError(res, 404, `no route for ${req.method} ${url.pathname}`);
      return await match.handler(req, res, { params: match.params, url });
    }
    if (serveStatic(res, PUBLIC_DIR, url.pathname)) return;
    // The agent installer is fetched by servers, not browsers.
    if (url.pathname === '/agent.js' || url.pathname === '/install-agent.sh') {
      const source = url.pathname === '/agent.js' ? path.join(ROOT, 'agent', 'agent.js') : path.join(PUBLIC_DIR, 'install-agent.sh');
      const body = fs.readFileSync(source);
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
    if (!res.headersSent) sendError(res, 500, err.message || 'internal error');
  }
});

server.listen(PORT, HOST, () => {
  const lan = Object.values(require('node:os').networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('');
  console.log('  WaterWall Panel');
  console.log('  ─────────────────────────────────────────');
  console.log(`  UI / API : http://${HOST}:${PORT}`);
  lan.forEach((ip) => console.log(`  LAN      : http://${ip}:${PORT}`));
  console.log(`  API token: ${panelToken}`);
  console.log(`  Data dir : ${DATA_DIR}`);
  console.log('');
  console.log('  Open the URL in a browser and sign in with the API token.');
  console.log('');
});
