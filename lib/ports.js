'use strict';

/**
 * Port conflicts between tunnels that share a server.
 *
 * Splitting the service (a second systemd unit, a second `core.json`) stops
 * one tunnel's config from overwriting another's, but it does not stop the
 * second WaterWall process from binding a port the first one already holds.
 * Two reality tunnels on the same Iran box both default to `userPort: 443`,
 * so the second service starts, fails to bind, and the tunnel never comes up.
 *
 * This module answers two questions:
 *
 *  - which ports does this tunnel's bundle ask a given server to listen on?
 *  - which of those are already taken on that server, by another tunnel or by
 *    the operating system?
 *
 * The answer comes from the generated config rather than from the template
 * metadata, because a template can emit any number of listeners and only the
 * generated file knows which port ended up on which node. `TcpListener` and
 * `TcpUdpListener` are the node types that bind a socket; `TcpConnector` and
 * friends only dial out.
 */

const { preprocessConfig } = require('./generator');

/** Node types that open a listening socket. */
const LISTENER_TYPES = new Set(['TcpListener', 'TcpUdpListener']);

function parseConfig(text) {
  const pre = preprocessConfig(text);
  if (pre.problems && pre.problems.length) return null;
  try {
    return JSON.parse(pre.text);
  } catch {
    return null;
  }
}

/**
 * The ports a bundle asks one side to listen on.
 *
 * Returns a map of `port -> [node names]`. Ports shared by several nodes (the
 * reverse templates put the user listener and the reverse-link listener on the
 * same port on purpose) list every node that wants them.
 *
 * @param {Object} files  the side's files, `configs/…` plus `core.json`
 * @returns {{ports: Map<number, string[]>, total: number}}
 */
function listenPorts(files) {
  const ports = new Map();
  for (const [rel, text] of Object.entries(files || {})) {
    if (!rel.startsWith('configs/') || !rel.endsWith('.json')) continue;
    const config = parseConfig(text);
    if (!config) continue;
    for (const node of config.nodes || []) {
      if (!LISTENER_TYPES.has(String(node.type || ''))) continue;
      const port = Number(node.settings?.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      if (!ports.has(port)) ports.set(port, []);
      const name = String(node.name || '');
      if (!ports.get(port).includes(name)) ports.get(port).push(name);
    }
  }
  return { ports, total: ports.size };
}

/**
 * Which listening ports of `files` are already used on this server?
 *
 * `taken` is the set of ports the server is known to be using. It comes from
 * two sources, both optional:
 *
 *  - the other tunnels' bundles for the same server (the panel knows these),
 *  - the sockets the server actually has open (probed over SSH).
 *
 * @returns {Array<{port: number, nodes: string[]}>}
 */
function conflicts(files, taken) {
  const { ports } = listenPorts(files);
  const out = [];
  for (const [port, nodes] of ports) {
    if (taken.has(port)) out.push({ port, nodes });
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * Ports that are already used on a server, according to the panel's own data.
 *
 * Every other enabled tunnel that deploys to this server contributes the ports
 * its bundle wants to bind. The tunnel being checked is excluded, so
 * re-applying a tunnel does not look like a conflict with itself.
 *
 * @param {Store} store
 * @param {Object} tunnel      the tunnel under consideration
 * @param {Object} server      the server record it deploys to
 * @param {Function} build     `buildBundle(store, tunnel)`
 * @param {Function} resolve   `resolveTargets(servers, tunnel)`
 * @param {Function} forSide   `targetsForSide(targets, side)`
 */
function portsUsedByOthers(store, tunnel, server, build, resolve, forSide) {
  const taken = new Set();
  const servers = store.listServers();
  for (const other of store.listTunnels()) {
    if (!other || other.id === tunnel.id) continue;
    if (other.enabled === false) continue;
    const targets = resolve(servers, other);
    const sides = ['iran', 'relay', 'foreign'];
    for (const side of sides) {
      const fleet = forSide(targets, side);
      // Same physical box: the panel's record identity is not enough, because
      // two records can point at one host with different install paths.
      const sharesBox = fleet.some((s) => s.host === server.host);
      if (!sharesBox) continue;
      let built;
      try {
        built = build(store, other);
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
 * Pick a free port.
 *
 * The search starts at `preferred` and walks up; ports in `taken` and ports
 * the server already has open are skipped. A deterministic result matters:
 * the same tunnel must get the same port on every apply, or the config hash
 * changes and the service restarts for nothing.
 *
 * @param {number} preferred
 * @param {Set<number>} taken
 * @param {number} [limit] how far to walk before giving up
 */
function findFreePort(preferred, taken, limit = 200) {
  const start = Number(preferred);
  if (!Number.isInteger(start) || start < 1 || start > 65535) return null;
  for (let port = start; port <= Math.min(65535, start + limit); port += 1) {
    if (!taken.has(port)) return port;
  }
  for (let port = 1024; port <= 65535; port += 1) {
    if (!taken.has(port)) return port;
  }
  return null;
}

/**
 * Parse `ss -lnt` / `ss -lnu` output into a set of listening ports.
 *
 * `ss -H -lnt` prints one line per socket: `LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*`.
 * The local address is the fourth column; the port is after the last colon.
 */
function parseListeningPorts(stdout) {
  const ports = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    const idx = local.lastIndexOf(':');
    if (idx === -1) continue;
    const port = Number(local.slice(idx + 1).split('%')[0]);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return ports;
}

/**
 * Parse `ss -lntp` output into a map of `port -> set of owning pids`.
 *
 * The process column looks like `users:(("memfd:waterwall",pid=17700,fd=10))`.
 * The pid is what tells us *who* holds a socket, which is the difference
 * between a real collision and the tunnel's own service sitting on the port
 * it is about to be restarted on.
 *
 * @param {string} stdout
 * @returns {Map<number, Set<number>>}
 */
function parseListeningPortsWithPids(stdout) {
  const owners = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    const idx = local.lastIndexOf(':');
    if (idx === -1) continue;
    const port = Number(local.slice(idx + 1).split('%')[0]);
    if (!Number.isInteger(port) || port <= 0) continue;
    if (!owners.has(port)) owners.set(port, new Set());
    const pids = trimmed.match(/pid=(\d+)/g) || [];
    for (const raw of pids) {
      const pid = Number(raw.slice(4));
      if (Number.isInteger(pid) && pid > 0) owners.get(port).add(pid);
    }
  }
  return owners;
}

module.exports = {
  LISTENER_TYPES,
  listenPorts,
  conflicts,
  portsUsedByOthers,
  findFreePort,
  parseListeningPorts,
  parseListeningPortsWithPids,
};
