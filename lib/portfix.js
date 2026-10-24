'use strict';

/**
 * Resolve listening-port collisions between tunnels that share a server.
 *
 * Splitting the systemd unit (see `isolate.js`) keeps one tunnel's
 * `core.json` from replacing another's, but it does not make two WaterWall
 * processes on one box able to share a port. Two reality tunnels aimed at the
 * same Iran server both default to `userPort: 443`; the second process starts,
 * fails to bind, and the tunnel never comes up.
 *
 * The fix is to move the newcomer to a free port. This module:
 *
 *  - finds the listening ports a bundle asks a server to bind,
 *  - finds which of them are already taken on that server,
 *  - rewrites the option that produced the port, so the change survives a
 *    rebuild instead of living only in the generated file.
 *
 * The rewrite is done on the *option*, never on the generated config: options
 * are what the panel stores, what the form shows, and what both sides of the
 * tunnel read. A port that only existed in the generated file would come back
 * at the next build.
 */

const templates = require('./templates');
const { listenPorts, findFreePort, parseListeningPorts, parseListeningPortsWithPids } = require('./ports');
const { resolveTargets, targetsForSide } = require('./targets');
const { buildBundle } = require('./build');

/**
 * The option keys that become listening ports on a given side.
 *
 * @returns {string[]}
 */
function portKeysFor(template, side) {
  const map = template?.listenPorts;
  if (!map) return [];
  if (side === 'iran') return map.iran || [];
  if (side === 'foreign') return map.foreign || [];
  if (side === 'relay') return map.relay || [];
  return [];
}

/**
 * Option keys that must move together with `key`.
 *
 * The reverse templates keep the user port and the reverse-link port on the
 * same number unless `samePort` is off, and the templates derive one from the
 * other. Moving one without the other leaves the two ends pointing at
 * different ports.
 */
function partnersFor(template, key) {
  const pairs = template?.listenPorts?.pairs || [];
  for (const pair of pairs) {
    if (pair.includes(key)) return pair.filter((k) => k !== key);
  }
  return [];
}

/**
 * Ports another tunnel already wants on this server.
 *
 * Two tunnels can reach the same box through different records, so the
 * comparison is on the host, not on the record id.
 */
function portsUsedByPeers(store, tunnel, server) {
  const taken = new Set();
  const servers = store.listServers();
  for (const other of store.listTunnels()) {
    if (!other || other.id === tunnel.id) continue;
    if (other.enabled === false) continue;
    const otherTemplate = templates.get(other.template);
    if (!otherTemplate) continue;
    const targets = resolveTargets(servers, other);
    for (const side of ['iran', 'relay', 'foreign']) {
      const fleet = targetsForSide(targets, side);
      if (!fleet.some((s) => s.host === server.host)) continue;
      let built;
      try {
        built = buildBundle(store, other);
      } catch {
        continue;
      }
      if (!built?.ok) continue;
      const files = built.bundles?.[side];
      if (!files) continue;
      for (const port of listenPorts(files).ports.keys()) taken.add(port);
    }
  }
  return taken;
}

/**
 * Ports the server itself already has open.
 *
 * Probed over SSH; the panel asks for `ss` output rather than guessing, so a
 * port held by nginx or by an unrelated service is respected too.
 *
 * The tunnel's *own* service is excluded. Re-applying a tunnel restarts that
 * service, and the old process releases its sockets on the way down, so the
 * port it currently holds is not a collision — it is the port the tunnel is
 * supposed to keep. Counting it would make every apply push the tunnel one
 * port further up and break the links its users already have.
 *
 * @param {Object} server
 * @param {Function} ssh
 * @param {string[]} ownServices service names belonging to this tunnel
 * @returns {Promise<Set<number>>}
 */
async function portsOpenOnServer(server, ssh, ownServices = []) {
  const open = new Set();
  if (!ssh) return open;
  try {
    const probe = await ssh.sshExec(
      server,
      [
        'ss -H -lnt 2>/dev/null',
        'ss -H -lnu 2>/dev/null',
        'ss -H -lntp 2>/dev/null',
        ownServices.length
          ? `systemctl show ${ownServices.map((s) => `'${s}'`).join(' ')} -p Id -p MainPID --no-pager 2>/dev/null`
          : '',
      ].filter(Boolean).join('; '),
    );
    if (probe.failed) return open;

    // The pids of this tunnel's own services. A socket held by one of them
    // belongs to the tunnel itself, not to a competitor.
    const idToPid = new Map();
    let currentId = null;
    for (const line of String(probe.stdout || '').split(/\r?\n/)) {
      const idMatch = line.match(/^Id=(\S+)\s*$/);
      if (idMatch) {
        currentId = idMatch[1];
        continue;
      }
      const pidMatch = line.match(/^MainPID=(\d+)\s*$/);
      if (pidMatch && currentId) {
        const pid = Number(pidMatch[1]);
        if (pid > 0) idToPid.set(currentId, pid);
      }
    }
    const ownPids = new Set();
    for (const name of ownServices) {
      // `systemctl show` reports the unit with its `.service` suffix; the
      // panel stores the bare name.
      const pid = idToPid.get(name) || idToPid.get(`${name}.service`);
      if (pid) ownPids.add(pid);
    }

    const withPids = parseListeningPortsWithPids(probe.stdout);
    for (const [port, pids] of withPids) {
      // A port held only by our own service is not taken.
      if (pids.size && [...pids].every((pid) => ownPids.has(pid))) continue;
      open.add(port);
    }

    // The plain `ss` output has no process column, so it is the reliable
    // source for the ports themselves; the pid-aware pass above only decides
    // which of them to ignore.
    const plain = probe.stdout.split(/ss -H -ln[tu]p?/)[0];
    for (const port of parseListeningPorts(plain)) {
      const owners = withPids.get(port);
      if (owners && owners.size && [...owners].every((pid) => ownPids.has(pid))) continue;
      open.add(port);
    }
  } catch {
    /* probing is best effort; the panel's own knowledge still applies */
  }
  return open;
}

/**
 * Work out a new port for a conflicting option.
 *
 * @param {number} current   the port the tunnel asked for
 * @param {Set<number>} taken every port that cannot be used
 * @param {Set<number>} preferred the ports the tunnel would rather keep
 * @returns {number|null}
 */
function pickPort(current, taken, preferred = new Set()) {
  const free = findFreePort(current, taken);
  if (free !== null) return free;
  for (const port of preferred) {
    if (!taken.has(port)) return port;
  }
  return null;
}

/**
 * Move every conflicting port of one side out of the way.
 *
 * Returns the rewritten options plus a report the UI can show. Nothing is
 * changed in the store here; the caller decides whether to persist.
 *
 * @param {Store} store
 * @param {Object} tunnel
 * @param {Object} server     the server this side deploys to
 * @param {string} side       'iran' | 'relay' | 'foreign'
 * @param {Object} bundle     the built bundle (already isolated)
 * @param {Function} ssh      the ssh module
 * @returns {Promise<{options: Object, moved: Array<{from:number,to:number,key:string,side:string}>}>}
 */
async function resolvePortConflicts(store, tunnel, server, side, bundle, ssh) {
  const template = templates.get(tunnel.template);
  // The built bundle carries the effective options: the ones the panel stored
  // plus everything the template provisioned. The stored options alone are
  // not enough, because a port that was never written down is still bound.
  const effective = { ...(tunnel.options || {}), ...(bundle?.options || {}) };
  const result = { options: { ...effective }, moved: [] };
  if (!template) return result;

  const keys = portKeysFor(template, side);
  if (!keys.length) return result;

  const files = bundle?.bundles?.[side];
  if (!files) return result;

  const wanted = listenPorts(files).ports;
  if (!wanted.size) return result;

  const taken = portsUsedByPeers(store, tunnel, server);
  // The tunnel's own service on this box is not a competitor: it is the
  // service that is about to be restarted with this very bundle.
  const ownServices = [server.serviceName].filter(Boolean);
  const open = await portsOpenOnServer(server, ssh, ownServices);
  for (const port of open) taken.add(port);

  const options = { ...result.options };
  for (const key of keys) {
    const current = Number(options[key]);
    if (!Number.isInteger(current) || current <= 0) continue;
    // Only a port that is actually bound by this bundle can conflict.
    const boundHere = wanted.has(current);
    if (!boundHere) continue;
    if (!taken.has(current)) continue;

    const next = pickPort(current, taken);
    if (next === null || next === current) continue;

    options[key] = next;
    taken.delete(current);
    taken.add(next);
    result.moved.push({ side, key, from: current, to: next });

    // Keep the paired options in step: the two ends of a reverse tunnel must
    // agree on the number.
    for (const partner of partnersFor(template, key)) {
      const partnerValue = Number(options[partner]);
      if (!Number.isInteger(partnerValue)) continue;
      // The pair only follows when it was sharing the old value.
      if (partnerValue === current) options[partner] = next;
    }
  }

  result.options = options;
  return result;
}

module.exports = {
  portKeysFor,
  partnersFor,
  portsUsedByPeers,
  portsOpenOnServer,
  pickPort,
  resolvePortConflicts,
};
