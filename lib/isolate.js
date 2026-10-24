'use strict';

const templates = require('./templates');
const { resolveTargets, targetsForSide, foreignIds } = require('./targets');

/**
 * Automatic service isolation.
 *
 * A server record is one WaterWall install path plus one systemd unit. Deploying
 * a second tunnel to the same record means the second bundle's `core.json`
 * replaces the first one's, and both configs often listen on the same port. The
 * tunnel that was working quietly disappears the next time the service starts.
 *
 * The panel cannot merge two arbitrary tunnels into one core and expect their
 * ports to coexist, so when an enabled tunnel already owns a target record the
 * new tunnel gets a clone of that record: same host and credentials, new
 * `serviceName` and `waterwallPath`. The clone's binary is copied on the server,
 * a unit is installed, and the tunnel's target list is switched to the clone
 * before anything is written.
 *
 * Only direct SSH is isolated. An agent-managed record with no SSH credentials
 * cannot create a second service, so the caller reports it instead of deploying
 * into a collision.
 */

const SERVICE_RE = /^[A-Za-z0-9_.@-]+$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

function declaredSides(tunnel) {
  const template = templates.get(tunnel?.template);
  return Array.isArray(template?.sides) && template.sides.length ? template.sides : ['iran', 'foreign'];
}

/** Does `other` deploy to this exact server record? */
function usesServer(servers, other, server) {
  if (!other || other.id === server.id) return false;
  const sides = declaredSides(other);
  if (!sides.includes(server.role)) return false;
  const targets = resolveTargets(servers, other);
  return targetsForSide(targets, server.role).some((candidate) => candidate.id === server.id);
}

/**
 * Every (side, server) pair in this tunnel that another enabled tunnel already
 * deploys to.
 */
function isolationPlan(store, tunnel, sides) {
  const servers = store.listServers();
  const targets = resolveTargets(servers, tunnel);
  const others = store
    .listTunnels()
    .filter((other) => other.id !== tunnel.id && other.enabled !== false);
  const plan = [];
  for (const side of sides) {
    for (const server of targetsForSide(targets, side)) {
      const shared = others.filter((other) => usesServer(servers, other, server));
      if (!shared.length) continue;
      plan.push({
        side,
        server,
        sharedWith: shared.map((other) => ({ id: other.id, name: other.name })),
      });
    }
  }
  return plan;
}

function suffix(base, n) {
  return `${String(base || '').replace(/\/+$/, '')}-${n}`;
}

/**
 * First free `-2`, `-3`, … service/path pair on this host.
 *
 * The store is checked first (cheap), then the server itself, because a failed
 * earlier apply can leave a unit or a directory behind without a record.
 */
async function chooseCloneSpec(store, server, ssh) {
  const baseSvc = server.serviceName || 'waterwall';
  const basePath = String(server.waterwallPath || '/opt/waterwall').replace(/\/+$/, '');
  const peers = store.listServers().filter((s) => s.host === server.host);
  for (let n = 2; n <= 30; n += 1) {
    const serviceName = suffix(baseSvc, n);
    const waterwallPath = suffix(basePath, n);
    if (!SERVICE_RE.test(serviceName) || !PATH_RE.test(waterwallPath)) continue;
    if (peers.some((s) => s.serviceName === serviceName || s.waterwallPath === waterwallPath)) continue;
    const probe = await ssh.sshExec(
      server,
      [
        `if [ -e ${ssh.shellQuote(waterwallPath)} ]; then echo TAKEN;`,
        `elif systemctl cat ${ssh.shellQuote(serviceName)} >/dev/null 2>&1; then echo TAKEN;`,
        'else echo FREE; fi',
      ].join(' '),
    );
    if (!probe.failed && /\bFREE\b/.test(probe.stdout)) {
      return { n, serviceName, waterwallPath };
    }
  }
  return null;
}

async function isolateTargets(store, tunnel, sides, ssh) {
  const plan = isolationPlan(store, tunnel, sides);
  const result = {
    ok: true,
    plan,
    clones: [],
    skipped: [],
    changed: false,
    targets: null,
  };
  if (!plan.length) return result;

  const original = tunnel.targetServers || {};
  const wasArray = Array.isArray(original.foreign);
  const next = {
    ...original,
    foreign: wasArray ? [...foreignIds(tunnel)] : original.foreign || null,
  };

  for (const row of plan) {
    const base = row.server;
    if (base.agentEnabled && !base.sshPassword && !base.sshKeyPath) {
      result.skipped.push({
        ...row,
        reason:
          'این سرور با ایجنت مدیریت می‌شود و برای ساخت سرویس دوم SSH/key ندارد؛ ابتدا یک کلید SSH روی آن ثبت کنید یا سرویس جداگانه بسازید.',
      });
      continue;
    }
    const spec = await chooseCloneSpec(store, base, ssh);
    if (!spec) {
      result.skipped.push({ ...row, reason: 'جای خالی برای سرویس دوم روی این سرور پیدا نشد (۲ تا ۳۰).' });
      continue;
    }
    const made = await ssh.ensureWaterwallService(base, {
      sourcePath: base.waterwallPath || '/opt/waterwall',
      waterwallPath: spec.waterwallPath,
      serviceName: spec.serviceName,
    });
    if (!made.ok) {
      result.skipped.push({ ...row, reason: made.error || 'ساخت سرویس دوم روی سرور ناموفق بود.' });
      continue;
    }
    const clone = store.addServer({
      name: `${base.name} · ${tunnel.name}`.slice(0, 80),
      role: base.role,
      host: base.host,
      sshPort: base.sshPort,
      sshUser: base.sshUser,
      sshKeyPath: base.sshKeyPath,
      sshPassword: base.sshPassword,
      waterwallPath: spec.waterwallPath,
      serviceName: spec.serviceName,
      agentEnabled: false,
      clonedFrom: base.id,
      clonedFor: tunnel.id,
    });
    if (row.side === 'foreign') {
      if (wasArray) {
        const at = next.foreign.indexOf(base.id);
        if (at === -1) next.foreign.push(clone.id);
        else next.foreign[at] = clone.id;
      } else {
        next.foreign = clone.id;
      }
    } else {
      next[row.side] = clone.id;
    }
    result.clones.push({
      side: row.side,
      from: { id: base.id, name: base.name, host: base.host },
      server: { id: clone.id, name: clone.name, serviceName: clone.serviceName, waterwallPath: clone.waterwallPath },
      sharedWith: row.sharedWith,
    });
    result.changed = true;
  }

  result.targets = next;
  result.ok = result.skipped.length === 0;
  return result;
}

module.exports = {
  declaredSides,
  usesServer,
  isolationPlan,
  chooseCloneSpec,
  isolateTargets,
  SERVICE_RE,
  PATH_RE,
};
