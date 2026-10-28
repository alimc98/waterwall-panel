'use strict';

const { preprocessConfig } = require('./generator');
const { resolveTargets } = require('./targets');

/**
 * Tunnel health watchdog.
 *
 * WaterWall exposes no metrics API, so "is this tunnel passing data?" has to
 * be inferred from the outside. The agent on each server probes the ports that
 * matter for its side and reports the results with its status; this module
 * turns those reports into one verdict per tunnel.
 *
 * The probes are derived from the generated bundle itself, not from option
 * names, so every template is covered without a per-template table:
 *
 *  - Iran (and relay) side: every `TcpListener` without a `whitelist` is the
 *    user-facing entry — probing it from the box itself tells whether the
 *    entry accepts connections at all.
 *  - Foreign side: the terminal `TcpConnector` nodes are where the traffic
 *    leaves the process. The one that points at the Iran entry is the reverse
 *    link (`link`); the others are the exit / local service (`exit`).
 *
 * A bare TCP connect is enough: a listener that accepts but then resets is
 * still a listener that is up, and the reverse link is a dial from the foreign
 * box to the Iran reverse port — exactly the connection ReverseClient keeps
 * alive.
 */

const LISTENER = 'TcpListener';
const CONNECTOR = 'TcpConnector';

/** The one config file of a side's bundle (`core.json` holds no nodes). */
function sideConfig(sideFiles) {
  const key = Object.keys(sideFiles || {}).find(
    (k) => k.startsWith('configs/') && k.endsWith('.json'),
  );
  if (!key) return null;
  const pre = preprocessConfig(sideFiles[key]);
  if (pre.problems.length) return null;
  try {
    return JSON.parse(pre.text);
  } catch {
    return null;
  }
}

/** A listener bound to every interface can be probed from the box itself. */
function probeAddress(address) {
  const a = String(address || '').trim();
  if (!a || a === '0.0.0.0' || a === '::' || a === '[::]') return '127.0.0.1';
  return a;
}

/**
 * The probes one server should run for one tunnel.
 *
 * `sideFiles` is exactly the file map that side receives — for a helper exit
 * that is the tailored bundle, whose outbound points at the main exit, so the
 * probes match what is really deployed (a helper probes the main exit's
 * address, not its own empty localhost). `ctx.iranHost` names the Iran entry;
 * the stored options are not always patched yet.
 *
 * @param {object} tunnel the stored tunnel
 * @param {object} sideFiles the side's file map (`configs/*.json` + core.json)
 * @param {object} server the server record this side deploys to
 * @param {{iranHost?: string}} ctx
 * @returns {Array<{tunnelId: string, name: string, host: string, port: number}>}
 */
function checksForServer(tunnel, sideFiles, server, ctx = {}) {
  const checks = [];
  const push = (name, host, port) => {
    const p = Number(port);
    if (host && Number.isInteger(p) && p > 0 && p < 65536) {
      checks.push({ tunnelId: tunnel.id, name, host: String(host), port: p });
    }
  };

  if (server.role === 'iran' || server.role === 'relay') {
    const cfg = sideConfig(sideFiles);
    for (const n of cfg?.nodes || []) {
      // Whitelisted listeners are the reverse entry: only the exits may dial
      // them, so a loopback probe would be refused. The user-facing entry has
      // no whitelist.
      if (n.type === LISTENER && !n.settings?.whitelist) {
        push('users', probeAddress(n.settings?.address), n.settings?.port);
      }
    }
    return checks;
  }

  if (server.role === 'foreign') {
    const cfg = sideConfig(sideFiles);
    if (!cfg) return checks;
    const iranHost = String(ctx.iranHost || tunnel.options?.iranHost || '').toLowerCase();
    for (const n of cfg.nodes || []) {
      // Only the end of a chain carries the destination: a node with no
      // `next`. Everything else forwards onward.
      if (n.type !== CONNECTOR || n.next) continue;
      const host = String(n.settings?.address || '');
      if (!host) continue;
      if (iranHost && host.toLowerCase() === iranHost) push('link', host, n.settings?.port);
      else push('exit', host, n.settings?.port);
    }
  }
  return checks;
}

const STATE_LABELS = {
  ok: 'سالم',
  'service-down': 'سرویس خاموش',
  'entry-down': 'ورودی قطع',
  'exit-down': 'خروجی قطع',
  'link-down': 'لینک معکوس قطع',
  degraded: 'نیمه‌کار',
  unknown: 'نامشخص',
};

function checkResult(c) {
  return c?.ok === true;
}

/**
 * One verdict per tunnel from the latest agent reports.
 *
 * No probing happens here — the panel only reads what the agents already
 * reported, so evaluation is free and can run on every render.
 *
 * @returns {{state: string, ok: boolean, label: string, problems: string[],
 *            sides: Array, checkedAt: string|null}}
 */
function evaluateTunnel(tunnel, servers) {
  const targets = resolveTargets(servers, tunnel);
  const involved = [];
  if (targets.iran) involved.push({ side: 'iran', server: targets.iran });
  if (targets.relay) involved.push({ side: 'relay', server: targets.relay });
  for (const f of targets.foreign || []) involved.push({ side: 'foreign', server: f });

  const perServer = involved.map(({ side, server }) => {
    const status = server.lastStatus || {};
    const checks = (status.checks || []).filter((c) => c && c.tunnelId === tunnel.id);
    return {
      side,
      serverId: server.id,
      serverName: server.name,
      service: status.service || 'unknown',
      checks,
      users: checks.find((c) => c.name === 'users'),
      link: checks.find((c) => c.name === 'link'),
      exits: checks.filter((c) => c.name === 'exit'),
    };
  });

  const problems = [];
  const anyData = perServer.some((p) => p.checks.length);

  // 1. A dead service is the loudest failure: nothing else can work.
  const down = perServer.filter((p) => p.service !== 'active');
  for (const p of down) {
    problems.push(`سرویس واتروال روی «${p.serverName}» (${p.side}) خاموش است — حالت: ${p.service}`);
  }

  // 2. Entry: the user-facing listener on the Iran box.
  const iran = perServer.find((p) => p.side === 'iran');
  const entryFailing =
    iran && iran.users && !checkResult(iran.users)
      ? `ورودی کاربران روی «${iran.serverName}» پورت ${iran.users.port} پاسخ نمی‌دهد`
      : null;
  if (entryFailing) problems.push(entryFailing);

  // 3. Exits: the local service / destination on the foreign boxes. A reverse
  //    tunnel stays up as long as one exit works, so "all failing" is the
  //    tunnel-down case and "some failing" is degradation.
  const foreignRows = perServer.filter((p) => p.side === 'foreign');
  const exitRows = foreignRows.filter((p) => p.exits.length);
  const exitFailed = exitRows.filter((p) => p.exits.every((c) => !checkResult(c)));
  const exitPartial =
    exitRows.length && exitFailed.length && exitFailed.length < exitRows.length;
  for (const p of exitFailed) {
    const ports = [...new Set(p.exits.map((c) => c.port))].join('، ');
    problems.push(`خروجی روی «${p.serverName}» (پورت ${ports}) پاسخ نمی‌دهد — سرویس محلی یا مقصد قطع است`);
  }

  // 4. Reverse link: foreign box -> Iran reverse port.
  const linkRows = foreignRows.filter((p) => p.link);
  const linkFailed = linkRows.filter((p) => !checkResult(p.link));
  for (const p of linkFailed) {
    problems.push(
      `لینک معکوس از «${p.serverName}» به ${p.link.host}:${p.link.port} برقرار نمی‌شود`,
    );
  }

  let state;
  if (!anyData) {
    state = 'unknown';
    problems.push('هنوز گزارشی از ایجنت نشده — یا ایجنت قدیمی است، یا هنوز یک چرخه گذشته نکرده');
  } else if (down.length) {
    state = 'service-down';
  } else if (entryFailing) {
    state = 'entry-down';
  } else if (exitRows.length && exitFailed.length === exitRows.length) {
    state = 'exit-down';
  } else if (linkRows.length && linkFailed.length === linkRows.length) {
    state = 'link-down';
  } else if (exitPartial || linkFailed.length) {
    state = 'degraded';
  } else {
    state = 'ok';
  }

  return {
    state,
    ok: state === 'ok',
    label: STATE_LABELS[state] || state,
    problems,
    sides: perServer.map((p) => ({
      side: p.side,
      serverId: p.serverId,
      serverName: p.serverName,
      service: p.service,
      checks: p.checks.map((c) => ({
        name: c.name,
        host: c.host,
        port: c.port,
        ok: c.ok === true,
        ms: Number.isFinite(c.ms) ? c.ms : null,
        error: c.error || null,
      })),
    })),
    checkedAt: perServer.some((p) => p.checks.length)
      ? new Date().toISOString()
      : null,
  };
}

module.exports = { checksForServer, evaluateTunnel, STATE_LABELS, sideConfig };
