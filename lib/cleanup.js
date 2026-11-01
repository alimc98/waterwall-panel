'use strict';

const path = require('node:path');
const { resolveTargets, foreignIds } = require('./targets');
const { tunnelConfigSuffix } = require('./build');

/**
 * Taking a deleted tunnel off its servers.
 *
 * This lives outside server.js so the destructive path can be tested without a
 * live box. The rules it enforces:
 *
 *  - only the servers the tunnel actually names are touched (an id that no
 *    longer resolves must not fall back to "the first server of that role"),
 *  - configs from earlier builds of the same tunnel are removed too, using the
 *    stable tunnel-id suffix, not only the current template's file names,
 *  - core.json is pruned, and when nothing is left the unit, enable symlink and
 *    (for a clone) the install directory go with it,
 *  - the result is verified on the box itself; a `rm` that quietly failed is
 *    reported as a failed cleanup instead of a success.
 */

/**
 * Every server a deleted tunnel may have touched, resolved by id only.
 *
 * `resolveTargets` falls back to the first server of a role when an id is
 * missing. That is fine for building a config, but it must never decide where
 * a destructive cleanup runs: deleting a tunnel whose exit record was removed
 * would otherwise clean (and stop) an unrelated box. Legacy tunnels that never
 * stored target ids are the one case where the old fallback is all there is.
 */
function cleanupPlan(store, tunnel) {
  const servers = store.listServers();
  const byId = new Map(servers.map((s) => [s.id, s]));
  const targets = tunnel.targetServers || {};
  const explicit = Boolean(targets.iran) || Boolean(targets.relay) || foreignIds(tunnel).length > 0;
  const rows = new Map();
  const add = (server, side) => {
    if (!server) return;
    const row = rows.get(server.id) || { server, sides: new Set() };
    row.sides.add(side);
    rows.set(server.id, row);
  };
  if (explicit) {
    add(byId.get(targets.iran), 'iran');
    add(byId.get(targets.relay), 'relay');
    for (const id of foreignIds(tunnel)) add(byId.get(id), 'foreign');
  } else {
    const resolved = resolveTargets(servers, tunnel);
    add(resolved.iran, 'iran');
    add(resolved.relay, 'relay');
    for (const server of resolved.foreign) add(server, 'foreign');
  }
  // A clone belongs to exactly one tunnel. If the record is still around it
  // must be cleaned even when the tunnel no longer points at it, otherwise its
  // unit and directory survive the deletion with nothing left to reach them.
  for (const server of servers) {
    if (server.clonedFor === tunnel.id) add(server, server.role || 'foreign');
  }
  return [...rows.values()].map((row) => ({ server: row.server, sides: [...row.sides] }));
}

/**
 * Take one tunnel off one server, forcefully and verifiably.
 *
 * @param {object} server
 * @param {string[]} files      current bundle paths (`core.json`, `configs/...`)
 * @param {object} ssh          the ssh module (injectable for tests)
 * @param {object} opts         `{suffix, force}`
 */
async function removeTunnelFromServer(server, files, ssh, { suffix = '', force = true } = {}) {
  const base = server.waterwallPath || '/opt/waterwall';
  let removed;
  try {
    removed = await ssh.removeTunnelConfigs(server, base, files, { suffix });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  if (!removed.ok) return { ok: false, error: removed.error };

  const corePath = path.posix.join(base, 'core.json');
  const read = await ssh.readRemoteFile(server, corePath);
  // `readRemoteFile` suppresses cat's own error for a missing file, so a
  // non-empty error means the read itself failed (SSH down, permission). Do not
  // treat that as "there is no core.json": stopping a shared unit because one
  // command failed would take the other tunnels on this box down with it.
  if (!read.ok && read.error && String(read.error).trim()) {
    return { ok: false, error: `could not read core.json: ${read.error}`, deleted: removed.deleted };
  }
  let core = null;
  let coreError = null;
  if (read.ok && read.content && read.content.trim()) {
    try {
      core = JSON.parse(read.content);
    } catch (err) {
      coreError = err.message;
    }
  }

  const result = { ok: true, deleted: removed.deleted };
  const stopService = async () => {
    const stop = await ssh.serviceAction(server, 'stop');
    await ssh.sshExec(
      server,
      `systemctl disable ${ssh.shellQuote(server.serviceName || 'waterwall')} 2>&1`,
    );
    result.service = `stopped (${(stop.output || '').split(/\r?\n/)[0] || 'inactive'})`;
  };

  /**
   * Tear the install down completely when this server has nothing left.
   *
   * A clone (a record with `clonedFrom`) exists only for the tunnel that
   * asked for it, so its unit *and* its directory go away together. A base
   * install may still be the binary of record for the box and is shared with
   * the panel's other tunnels, so only its unit is removed; the directory
   * stays so a later tunnel can reuse the binary without downloading it.
   */
  const removeInstall = async ({ sweep = false } = {}) => {
    const isClone = Boolean(server.clonedFrom || server.clonedFor);
    const removedInstall = await ssh.removeWaterwallInstall(server, {
      waterwallPath: base,
      serviceName: server.serviceName || 'waterwall',
      removeDir: isClone,
      // Only sweep units once nothing is left to load. While another tunnel
      // still has a config in this install, those units may be serving it.
      sweepUnits: sweep === true,
    });
    if (!removedInstall.ok) {
      result.install = { ok: false, error: removedInstall.error };
      result.ok = false;
      return false;
    }
    result.install = {
      ok: true,
      unitRemoved: removedInstall.unitRemoved,
      dirRemoved: removedInstall.dirRemoved,
      dirKept: !isClone && removedInstall.dirExists,
      sweptUnits: removedInstall.sweptUnits || [],
    };
    return true;
  };

  if (!core || !Array.isArray(core.configs)) {
    // Nothing loads these files without a readable core.json. Only touch the
    // unit when this server really held the tunnel; an unreadable core that is
    // not ours is reported rather than overwritten.
    const nothingLeft = Array.isArray(removed.after) && removed.after.length === 0;
    if (removed.deleted.length || (force && nothingLeft)) {
      if (coreError) {
        result.ok = false;
        result.core = 'unreadable';
        result.error = `core.json is not valid JSON (${coreError}); files were removed but the service was left alone`;
        return result;
      }
      await stopService();
      await removeInstall({ sweep: true });
      result.core = 'absent';
    } else result.service = 'not deployed here';
    return result;
  }

  // A config that is no longer on disk must not stay in the boot list. This
  // also drops entries left by earlier deletions, which is the only place the
  // panel ever notices them.
  const kept = core.configs.filter((entry) => {
    const rel = String(entry).replace(/^\.?\//, '');
    return removed.after.includes(path.posix.basename(rel));
  });

  if (!kept.length && !core.configs.length && !removed.deleted.length) {
    // An already-empty core.json on a server that held none of this tunnel's
    // files is not ours to remove.
    result.core = 'empty';
    result.service = 'not deployed here';
    return result;
  }
  if (!kept.length) {
    await ssh.sshExec(server, `rm -f ${ssh.shellQuote(corePath)} ${ssh.shellQuote(corePath)}.bak.*`);
    await stopService();
    // Nothing is left on this box for this tunnel: the unit file and, for a
    // clone, the whole install directory go away too. Leaving them behind is
    // what fills /opt with dead services after a few tunnels are created and
    // deleted.
    await removeInstall({ sweep: true });
    result.core = 'removed';
    return result;
  }
  if (kept.length === core.configs.length) {
    // core.json never named this tunnel, so the running service is fine: the
    // files (if any) are gone and there is nothing left to reload.
    result.core = 'unchanged';
    if (!removed.deleted.length) result.service = 'not deployed here';
    return result;
  }
  const written = await ssh.uploadFiles(
    server,
    { 'core.json': `${JSON.stringify({ ...core, configs: kept }, null, 2)}\n` },
    base,
  );
  if (!written.ok) return { ok: false, error: written.error, deleted: result.deleted };
  if (force) {
    const restart = await ssh.serviceAction(server, 'restart');
    result.core = 'pruned';
    result.kept = kept;
    result.service = restart.ok ? 'restarted' : restart.output;
  }
  return result;
}

/**
 * Confirm on the box itself that the tunnel is gone.
 *
 * The cleanup can report success while a config file is still there (a `rm`
 * that failed, a wrong install path), and that is exactly the complaint this
 * path exists to fix. The list is read back from the same directory the removal
 * ran in, so the answer is about the real box and not about what the panel
 * thinks it wrote.
 */
async function verifyTunnelCleanup(server, ssh, { base, suffix, serviceName, paths = [], expectUnitRemoved = false }) {
  if (!suffix) return null;
  const configDir = `${base}/configs`;
  const leftovers = [
    `ls -1 ${ssh.shellQuote(configDir)}/*-${suffix}.json ${ssh.shellQuote(configDir)}/*_${suffix}.json 2>/dev/null || true`,
    ...paths
      .filter((p) => typeof p === 'string' && p.startsWith('configs/'))
      .map((p) => `[ -f ${ssh.shellQuote(`${base}/${p}`)} ] && echo ${ssh.shellQuote(p)} || true`),
  ];
  const script = [
    `echo "CONFIGS=$( { ${leftovers.join('\n')}; } | sort -u | wc -l)"`,
    `echo "UNIT_EXISTS=$([ -f ${ssh.shellQuote(`/etc/systemd/system/${serviceName}.service`)} ] && echo yes || echo no)"`,
    `echo "SVC_ACTIVE=$(systemctl is-active ${ssh.shellQuote(serviceName)} 2>/dev/null || true)"`,
  ].join('\n');
  const res = await ssh.sshExec(server, script, { timeout: 30000 });
  if (res.failed) return { ok: false, error: res.stderr || 'verification failed' };
  const field = (name) => {
    const m = res.stdout.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const configsLeft = Number(field('CONFIGS')) || 0;
  const unitExists = field('UNIT_EXISTS') === 'yes';
  return {
    // The unit is allowed to stay when other tunnels still load configs from
    // this install; only a unit that should have gone away counts.
    ok: configsLeft === 0 && (!expectUnitRemoved || !unitExists),
    expectUnitRemoved,
    configsLeft,
    unitExists,
    serviceActive: field('SVC_ACTIVE') || 'unknown',
  };
}

async function removeTunnelFromServers(store, tunnel, ssh, buildBundle) {
  const bundle = buildBundle(store, tunnel);
  const suffix = tunnelConfigSuffix(tunnel);
  const rows = [];
  for (const { server, sides } of cleanupPlan(store, tunnel)) {
    // The bundle only names the files of the current template. Old builds of
    // the same tunnel are found by the id suffix inside removeTunnelConfigs.
    const files = [];
    for (const side of sides) {
      for (const file of Object.keys(bundle.bundles?.[side] || {})) files.push(file);
    }
    // Sequential on purpose: a deletion is a handful of servers and each one
    // runs a few ssh commands; firing them in parallel buys nothing and makes
    // a failure harder to attribute.
    let row;
    try {
      row = await removeTunnelFromServer(server, files, ssh, { suffix, force: true });
    } catch (err) {
      row = { ok: false, error: err.message || String(err) };
    }
    const verification = row.ok
      ? await verifyTunnelCleanup(server, ssh, {
          base: server.waterwallPath || '/opt/waterwall',
          suffix,
          serviceName: server.serviceName || 'waterwall',
          paths: files,
          expectUnitRemoved: Boolean(row.install?.unitRemoved),
        }).catch((err) => ({ ok: false, error: err.message }))
      : null;
    if (verification && !verification.ok) {
      row.ok = false;
      row.error = row.error || 'پاک‌سازی ناقص ماند؛ فایل یا سرویس روی سرور باقی است';
    }
    rows.push({
      side: sides.join('+'),
      sides,
      server: server.name,
      host: server.host,
      ...row,
      verification,
    });
  }
  return rows;
}

module.exports = {
  cleanupPlan,
  removeTunnelFromServer,
  verifyTunnelCleanup,
  removeTunnelFromServers,
};
