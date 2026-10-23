'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const https = require('node:https');

/**
 * CDN link health for the dashboard.
 *
 * A reverse tunnel behind a CDN has exactly one public face: the hostname the
 * operator registered in the CDN. Everything else about the tunnel can look
 * healthy — configs uploaded, service running, exit servers online — while that
 * hostname is dead, because the CDN cannot reach the origin (wrong origin port,
 * origin protocol changed, service stopped, certificate mismatch).
 *
 * So the check has to be a request *through* the CDN, from the panel, to the
 * path the tunnel actually serves. Two shapes matter:
 *
 *   cdn-reverse-wss   the tunnel speaks WebSocket. A plain GET is answered with
 *                     502/520 by the edge even when the link is perfectly fine,
 *                     because WaterWall's HttpServer only completes an upgrade.
 *                     The probe therefore sends a real upgrade request and
 *                     treats 101 as the only healthy answer.
 *   cdn-reverse-split every request is half of a pair and gets an HTTP status,
 *                     so any answer below 500 means the origin is alive.
 *
 * The result is a verdict, not a config opinion: "the CDN answered 101 in 210ms"
 * or "the CDN says 520, it cannot reach the origin". That is the difference
 * between an operator checking five boxes and an operator knowing where to look.
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Templates whose whole point is a CDN in front of the Iran entry. */
const CDN_TEMPLATES = new Set(['cdn-reverse-wss', 'cdn-reverse-split']);

/** How long a probe result is reused before the next dashboard visit re-runs it. */
const TTL = 15000;
const cache = new Map();

function isCdnTunnel(tunnel) {
  if (!tunnel) return false;
  if (CDN_TEMPLATES.has(tunnel.template)) return true;
  // A hand-built tunnel with a CDN hostname is still a CDN link; showing it is
  // more useful than hiding it because its template id is unfamiliar.
  return Boolean(String(tunnel.options?.cdnHost || '').trim());
}

/** Split-mode paths may carry {id}/{direction}; a probe needs concrete values. */
function materialisePath(raw) {
  return String(raw || '/')
    .replace(/\{direction\}/gi, 'up')
    .replace(/\{[a-z-]+\}/gi, () => crypto.randomBytes(4).toString('hex'));
}

/**
 * The probe-relevant description of a tunnel: what to connect to, with which
 * Host/SNI, and which request shape the template answers.
 */
function describe(tunnel) {
  const o = tunnel.options || {};
  const kind = tunnel.template === 'cdn-reverse-split' ? 'split' : 'ws';
  const host = String(o.cdnHost || '').trim();
  const port = Number(o.cdnPort) || 443;
  // `edgeAddress` pins the connection to one edge IP while Host/SNI stay the
  // domain — exactly what the tunnel's own config does.
  const edge = String(o.edgeAddress || '').trim();
  const rawPath = kind === 'split' ? o.splitPath || '/' : o.wsPath || '/';
  return {
    tunnelId: tunnel.id,
    name: tunnel.name || tunnel.template,
    template: tunnel.template,
    kind,
    enabled: tunnel.enabled !== false,
    host,
    port,
    path: materialisePath(rawPath),
    connectHost: edge || host,
    userAgent: String(o.userAgent || '').trim() || DEFAULT_UA,
  };
}

const REASONS = {
  up: { label: 'سالم', cls: 'ok' },
  warn: { label: 'هشدار', cls: 'warn' },
  down: { label: 'قطع', cls: 'err' },
  dns: { label: 'DNS', cls: 'err' },
  timeout: { label: 'بی‌پاسخ', cls: 'err' },
  error: { label: 'خطا', cls: 'err' },
  off: { label: 'خاموش', cls: 'mute' },
  empty: { label: 'تنظیم نشده', cls: 'mute' },
};

/**
 * Turn an HTTP status into a verdict.
 *
 * 5xx is the CDN telling us the origin is unreachable — Cloudflare's 520-524
 * family and Arvan's 502 both mean the same thing here. A 4xx means the edge
 * answered but the path did not behave as the tunnel needs, which is a problem
 * worth showing without calling the link dead.
 */
function classify(kind, status) {
  if (!status) return { status: 'error', detail: 'پاسخی از CDN نرسید' };
  if (status >= 500) {
    return { status: 'down', detail: 'CDN به origin نمی‌رسد (۵xx)' };
  }
  if (kind === 'ws') {
    // Anything but 101 means the edge answered something other than the
    // upgrade the tunnel needs. That is not "the link is fine", even though the
    // hostname itself is reachable.
    if (status === 101) return { status: 'up', detail: 'ارتقای WebSocket انجام شد' };
    return { status: 'warn', detail: 'CDN پاسخ داد ولی ارتقای WebSocket انجام نشد' };
  }
  if (status >= 400) {
    return { status: 'warn', detail: 'CDN پاسخ داد ولی مسیر خطا برگرداند' };
  }
  return { status: 'up', detail: 'CDN پاسخ داد' };
}

/**
 * Resolve the CDN hostname with its own budget.
 *
 * Without this, a typo'd domain shows up as "no response" after the full probe
 * timeout — Node's resolver can spend ten seconds on NXDOMAIN depending on the
 * platform — and the operator chases the wrong thing. Resolving first turns the
 * most common mistake into an immediate, unmistakable "DNS" verdict.
 */
function lookupHost(host, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, slow: true });
    }, ms);
    dns.lookup(host, (err, address) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) resolve({ ok: false, code: err.code || 'ENOTFOUND' });
      else resolve({ ok: true, address });
    });
  });
}

async function probeOnce(link, timeoutMs) {
  const started = Date.now();
  let connectHost = link.connectHost;

  // A pinned edge address is already an address; only the domain case needs DNS.
  if (!link.connectHost || link.connectHost === link.host) {
    const resolved = await lookupHost(link.host, Math.min(2500, timeoutMs));
    if (resolved.ok) {
      connectHost = resolved.address;
    } else if (!resolved.slow) {
      // A resolver that answered "no such name" is a real verdict.
      return {
        ms: Date.now() - started,
        checkedAt: new Date().toISOString(),
        address: null,
        edge: null,
        httpStatus: null,
        status: 'dns',
        detail: `دامنه resolve نشد (${resolved.code})`,
      };
    }
    // A resolver that was merely slow is not evidence of a broken link — a
    // systemd-resolved box can take seconds on the first lookup after a restart
    // while the CDN is perfectly reachable. Fall through and let the request's
    // own deadline decide instead of reporting a false "down".
  }

  return new Promise((resolve) => {
    let settled = false;
    let req = null;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try {
        req?.destroy();
      } catch {
        /* already gone */
      }
      resolve({
        ms: Date.now() - started,
        checkedAt: new Date().toISOString(),
        address: null,
        edge: null,
        httpStatus: null,
        ...extra,
      });
    };

    // https's own `timeout` option only sets an idle timer on the socket; a
    // slow edge that keeps the socket open would never trip it. A hard deadline
    // keeps a dashboard visit bounded no matter what the edge does.
    const guard = setTimeout(
      () => finish({ status: 'timeout', detail: `در ${timeoutMs} میلی‌ثانیه پاسخی نرسید` }),
      timeoutMs,
    );

    const headers = {
      host: link.host,
      'user-agent': link.userAgent,
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      connection: 'close',
    };
    if (link.kind === 'ws') {
      headers.connection = 'Upgrade';
      headers.upgrade = 'websocket';
      headers['sec-websocket-version'] = '13';
      headers['sec-websocket-key'] = crypto.randomBytes(16).toString('base64');
    }

    try {
      req = https.request({
        host: connectHost,
        port: link.port,
        path: link.path,
        method: 'GET',
        headers,
        servername: link.host, // SNI stays the domain even with a pinned edge IP
        rejectUnauthorized: false, // the origin certificate is WaterWall's own
        agent: false,
      });
    } catch (err) {
      return finish({ status: 'error', detail: err.message });
    }

    req.on('upgrade', (res, socket) => {
      // Read the address before destroying: destroy() clears it, and the pinned
      // edge's IP is the first thing to check when a domain resolves oddly.
      const address = socket?.remoteAddress || null;
      socket?.destroy();
      const verdict = classify(link.kind, res.statusCode);
      finish({
        ...verdict,
        httpStatus: res.statusCode,
        address,
        edge: res.headers?.server || null,
      });
    });

    req.on('response', (res) => {
      const verdict = classify(link.kind, res.statusCode);
      finish({
        ...verdict,
        httpStatus: res.statusCode,
        address: res.socket?.remoteAddress || null,
        edge: res.headers?.server || null,
      });
      res.resume();
      res.destroy();
    });

    req.on('timeout', () => finish({ status: 'timeout', detail: `در ${timeoutMs} میلی‌ثانیه پاسخی نرسید` }));

    req.on('error', (err) => {
      const code = err.code || '';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
        return finish({ status: 'dns', detail: `دامنه resolve نشد (${code})` });
      }
      if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EPIPE') {
        return finish({ status: 'timeout', detail: `اتصال قطع شد (${code})` });
      }
      if (code === 'ECONNREFUSED') {
        return finish({ status: 'down', detail: 'پورت روی CDN بسته است (ECONNREFUSED)' });
      }
      finish({ status: 'error', detail: err.message });
    });

    req.end();
  });
}

/**
 * Check every CDN tunnel, newest state first.
 *
 * Results are cached briefly so a dashboard that re-renders on every event does
 * not turn into a request loop against the CDN. `fresh` bypasses that for the
 * explicit "check now" button.
 */
async function checkTunnels(tunnels, { fresh = false, timeout = 8000 } = {}) {
  const links = (tunnels || []).filter(isCdnTunnel).map(describe);
  const live = new Set(links.map((l) => l.tunnelId));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);

  return Promise.all(
    links.map(async (link) => {
      if (!link.host) {
        return { ...link, status: 'empty', label: REASONS.empty.label, cls: REASONS.empty.cls, detail: 'دامنهٔ CDN تنظیم نشده' };
      }
      if (!link.enabled) {
        return { ...link, status: 'off', label: REASONS.off.label, cls: REASONS.off.cls, detail: 'تونل غیرفعال است' };
      }
      const key = `${link.connectHost}|${link.port}|${link.path}|${link.kind}`;
      const cached = cache.get(link.tunnelId);
      let result;
      if (!fresh && cached && cached.key === key && Date.now() - cached.at < TTL) {
        result = cached.result;
      } else {
        result = await probeOnce(link, timeout);
        cache.set(link.tunnelId, { key, at: Date.now(), result });
      }
      const meta = REASONS[result.status] || REASONS.error;
      return { ...link, ...result, label: meta.label, cls: meta.cls };
    }),
  );
}

module.exports = { isCdnTunnel, describe, materialisePath, classify, checkTunnels, REASONS, DEFAULT_UA };
