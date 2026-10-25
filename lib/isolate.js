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

/**
 * The root of a server record's clone family.
 *
 * A clone inherits its base's host, credentials and role, and it differs only
 * in the service name and the install path. So "the base record" and "a clone
 * of the base" are the same physical box as far as a tunnel is concerned: two
 * tunnels on the two of them still fight over the box's ports, and the panel
 * has to keep them apart just the same.
 *
 * The chain is walked upwards, so a clone of a clone still resolves to the
 * original base.
 */
function rootOf(servers, server) {
  let current = server;
  const seen = new Set();
  while (current && current.clonedFrom && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = servers.find((s) => s.id === current.clonedFrom);
    if (!parent) break;
    current = parent;
  }
  return current || server;
}

/**
 * Every record that belongs to the same physical box as `server`.
 *
 * This is the base record plus all of its clones, whichever way the clone
 * chain runs. Two tunnels that hold different members of this family are
 * still sharing one machine.
 */
function familyOf(servers, server) {
  const root = rootOf(servers, server);
  return servers.filter((s) => rootOf(servers, s).id === root.id);
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
 * Does `other` deploy to the same physical box as `server`?
 *
 * The exact-record check is not enough on its own. Once the first tunnel has
 * been moved onto a clone, the base record looks free even though the box is
 * still busy — so a second tunnel aimed at the base would quietly overwrite
 * the base's own `core.json` and fight the clone over the listening port, and
 * no third service would ever be created.
 *
 * Comparing whole families catches that: the base and its clones are one box.
 */
function sharesBox(servers, other, server) {
  if (!other || other.id === server.id) return false;
  const sides = declaredSides(other);
  if (!sides.includes(server.role)) return false;
  const targets = resolveTargets(servers, other);
  const mine = familyOf(servers, server).map((s) => s.id);
  return targetsForSide(targets, server.role).some((candidate) => mine.includes(candidate.id));
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
      const shared = others.filter((other) => sharesBox(servers, other, server));
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
 * Find a path on the box that really holds the WaterWall binary.
 *
 * A clone is made by copying the binary out of an existing install, so the
 * source path has to be checked against the box itself. The base record's
 * path is preferred, but a box whose base install was removed still has the
 * binary in one of its clones — refusing to clone there would leave the box
 * unable to run a second tunnel even though it has everything it needs.
 *
 * Returns `null` when no path on the box holds a binary; the caller reports
 * that as `NO_BINARY`.
 */
async function pickBinarySource(family, ssh) {
  if (!family.length) return null;
  const server = family[0];
  for (const member of family) {
    const path = String(member.waterwallPath || '').replace(/\/+$/, '');
    if (!path) continue;
    const probe = await ssh.sshExec(
      server,
      [
        `if [ -x ${ssh.shellQuote(`${path}/Waterwall`)} ] || ` +
          `[ -f ${ssh.shellQuote(`${path}/Waterwall`)} ]; then echo HAS_BINARY;`,
        'else echo NO_BINARY; fi',
      ].join(' '),
    );
    if (!probe.failed && /HAS_BINARY/.test(probe.stdout)) return path;
  }
  return null;
}

/**
 * First free `-2`, `-3`, … service/path pair on this host.
 *
 * The store is checked first (cheap), then the server itself, because a failed
 * earlier apply can leave a unit or a directory behind without a record.
 *
 * A clone that already exists for this tunnel is reused. Creating a fresh
 * clone on every apply piles up units and directories on the box, and each
 * new clone starts another service on the same port.
 *
 * The numbering always counts from the *base* record of the family. A clone
 * asked for its own clone would otherwise produce `waterwall-2-2`, and the
 * panel's server list would fill up with names nobody can predict.
 */
async function chooseCloneSpec(store, server, ssh, tunnelId = null) {
  const servers = store.listServers();
  // Number from the root of the family, so the third service on a box is
  // always `waterwall-3` no matter which member of the family was targeted.
  const root = rootOf(servers, server);
  const baseSvc = root.serviceName || 'waterwall';
  const basePath = String(root.waterwallPath || '/opt/waterwall').replace(/\/+$/, '');

  // The binary is copied from an existing install, so the source has to be a
  // path that really holds one. The base record's path is the first choice,
  // but a box whose base install was removed — the panel's own "install
  // WaterWall" was never run on it, say — still has the binary in one of its
  // clones. Without this, the clone is refused with `NO_BINARY` even though
  // the box has everything it needs.
  const family = familyOf(servers, server);
  const sourcePath = await pickBinarySource(family, ssh);

  // Reuse the clone this tunnel already has for this box. The lookup walks
  // the whole family: the tunnel may point at the base today and at its clone
  // tomorrow, and it must land on the same record either way.
  let stale = null;
  if (tunnelId) {
    const mine = store
      .listServers()
      .find(
        (s) =>
          s.host === server.host &&
          s.clonedFor === tunnelId &&
          (s.clonedFrom === server.id || s.clonedFrom === root.id || s.id === server.id),
      );
    if (mine) {
      const exists = await ssh.sshExec(
        server,
        [
          `if [ -d ${ssh.shellQuote(mine.waterwallPath)} ] && ` +
            `systemctl cat ${ssh.shellQuote(mine.serviceName)} >/dev/null 2>&1; then echo READY;`,
          'else echo GONE; fi',
        ].join(' '),
      );
      if (!exists.failed && /\bREADY\b/.test(exists.stdout)) {
        return {
          n: null,
          serviceName: mine.serviceName,
          waterwallPath: mine.waterwallPath,
          sourcePath: sourcePath || mine.waterwallPath,
          existing: mine,
          stale: null,
        };
      }
      // The clone is gone from the box (a manual cleanup, say). The record
      // is stale: it must not be reused as it is, and it must not simply be
      // dropped either — the tunnel still points at it, and deleting it
      // would leave the tunnel referring to a server that no longer exists.
      // It is carried along so the same record can be repointed at the fresh
      // clone below.
      stale = mine;
    }
  }

  // The stale record's own number is free again: it is about to be
  // repointed at the fresh clone. Every other member of the family counts as
  // taken, so the new number never collides with a live unit.
  //
  // The service name also has to be unique across the whole panel, not just
  // on this box: the server list is one table, and two rows both called
  // `waterwall-2` are impossible to tell apart. The path only has to be
  // unique on the box.
  const peers = store
    .listServers()
    .filter((s) => (!stale || s.id !== stale.id));
  const takenNames = new Set(peers.map((s) => s.serviceName).filter(Boolean));
  for (let n = 2; n <= 30; n += 1) {
    const serviceName = suffix(baseSvc, n);
    const waterwallPath = suffix(basePath, n);
    if (!SERVICE_RE.test(serviceName) || !PATH_RE.test(waterwallPath)) continue;
    if (takenNames.has(serviceName)) continue;
    if (
      peers.some(
        (s) => s.host === server.host && s.waterwallPath === waterwallPath,
      )
    ) {
      continue;
    }
    const probe = await ssh.sshExec(
      server,
      [
        `if [ -e ${ssh.shellQuote(waterwallPath)} ]; then echo TAKEN;`,
        `elif systemctl cat ${ssh.shellQuote(serviceName)} >/dev/null 2>&1; then echo TAKEN;`,
        'else echo FREE; fi',
      ].join(' '),
    );
    if (!probe.failed && /\bFREE\b/.test(probe.stdout)) {
      return { n, serviceName, waterwallPath, sourcePath, existing: null, stale };
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
    // The clone is always derived from the root of the family, so the panel's
    // server list keeps one flat chain of `waterwall`, `waterwall-2`,
    // `waterwall-3` per box instead of a tree of clones-of-clones.
    const root = rootOf(store.listServers(), base);
    if (base.agentEnabled && !base.sshPassword && !base.sshKeyPath) {
      result.skipped.push({
        ...row,
        reason:
          'این سرور با ایجنت مدیریت می‌شود و برای ساخت سرویس دوم SSH/key ندارد؛ ابتدا یک کلید SSH روی آن ثبت کنید یا سرویس جداگانه بسازید.',
      });
      continue;
    }
    const spec = await chooseCloneSpec(store, base, ssh, tunnel.id);
    if (!spec) {
      result.skipped.push({ ...row, reason: 'جای خالی برای سرویس دوم روی این سرور پیدا نشد (۲ تا ۳۰).' });
      continue;
    }
    let clone;
    if (spec.existing) {
      // This tunnel already owns a clone of this server. Reuse it instead of
      // making another one, so repeated applies do not pile up units.
      clone = spec.existing;
    } else if (spec.stale) {
      // The clone this tunnel owned is gone from the box. Repoint the same
      // record at the fresh clone instead of adding a second one: the tunnel
      // already refers to this record, and a new record would leave the old
      // id dangling.
      const made = await ssh.ensureWaterwallService(base, {
        sourcePath: spec.sourcePath || root.waterwallPath || '/opt/waterwall',
        waterwallPath: spec.waterwallPath,
        serviceName: spec.serviceName,
      });
      if (!made.ok) {
        result.skipped.push({ ...row, reason: made.error || 'ساخت سرویس دوم روی سرور ناموفق بود.' });
        continue;
      }
      clone = store.updateServer(spec.stale.id, {
        waterwallPath: spec.waterwallPath,
        serviceName: spec.serviceName,
        clonedFrom: root.id,
        clonedFor: tunnel.id,
      }) || spec.stale;
    } else {
      const made = await ssh.ensureWaterwallService(base, {
        sourcePath: spec.sourcePath || root.waterwallPath || '/opt/waterwall',
        waterwallPath: spec.waterwallPath,
        serviceName: spec.serviceName,
      });
      if (!made.ok) {
        result.skipped.push({ ...row, reason: made.error || 'ساخت سرویس دوم روی سرور ناموفق بود.' });
        continue;
      }
      clone = store.addServer({
        name: `${root.name} · ${tunnel.name}`.slice(0, 80),
        role: root.role,
        host: root.host,
        sshPort: root.sshPort,
        sshUser: root.sshUser,
        sshKeyPath: root.sshKeyPath,
        sshPassword: root.sshPassword,
        waterwallPath: spec.waterwallPath,
        serviceName: spec.serviceName,
        agentEnabled: false,
        clonedFrom: root.id,
        clonedFor: tunnel.id,
      });
    }
    let targetChanged = false;
    if (row.side === 'foreign') {
      if (wasArray) {
        const at = next.foreign.indexOf(base.id);
        if (at === -1) {
          next.foreign.push(clone.id);
          targetChanged = true;
        } else if (next.foreign[at] !== clone.id) {
          next.foreign[at] = clone.id;
          targetChanged = true;
        }
      } else if (next.foreign !== clone.id) {
        next.foreign = clone.id;
        targetChanged = true;
      }
    } else if (next[row.side] !== clone.id) {
      next[row.side] = clone.id;
      targetChanged = true;
    }
    result.clones.push({
      side: row.side,
      from: { id: base.id, name: base.name, host: base.host },
      server: { id: clone.id, name: clone.name, serviceName: clone.serviceName, waterwallPath: clone.waterwallPath },
      sharedWith: row.sharedWith,
      reused: Boolean(spec.existing),
    });
    if (targetChanged) result.changed = true;
  }

  result.targets = next;
  result.ok = result.skipped.length === 0;
  return result;
}

module.exports = {
  declaredSides,
  usesServer,
  sharesBox,
  rootOf,
  familyOf,
  isolationPlan,
  chooseCloneSpec,
  isolateTargets,
  SERVICE_RE,
  PATH_RE,
};
