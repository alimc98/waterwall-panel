'use strict';

/**
 * Which servers a tunnel is deployed to.
 *
 * Ordinary tunnels name exactly one server per side. Reverse tunnels can name
 * any number of foreign servers: every one of them runs the same exit config
 * and dials the Iran entry, while the ReverseServer pool inside WaterWall pairs
 * each user with whichever reverse link is free. That is what turns a reverse
 * tunnel into a load-balanced, fail-over link.
 *
 * The stored shape is `targetServers.foreign` as either a single id (the old
 * shape, still what ordinary templates write) or an array of ids, so every
 * reader has to come through here.
 */

function foreignIds(tunnel) {
  const value = tunnel?.targetServers?.foreign;
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

/**
 * Resolve target ids against the registered servers. An empty target list falls
 * back to the first server of that role, which is what the panel has always
 * done for tunnels created before target selection existed.
 */
function resolveTargets(servers, tunnel) {
  const byId = (id) => servers.find((s) => s.id === id) || null;
  const iran = byId(tunnel?.targetServers?.iran) || servers.find((s) => s.role === 'iran') || null;
  const ids = foreignIds(tunnel);
  let foreign = ids.map(byId).filter(Boolean);
  if (!foreign.length) {
    const fallback = servers.find((s) => s.role === 'foreign') || null;
    if (fallback) foreign = [fallback];
  }
  return { iran, foreign };
}

/**
 * Does this agent's server take part in the tunnel?
 *
 * A tunnel with no explicit targets keeps the historical role-wide behaviour
 * (every server of that role deploys it). Once targets are named, only those
 * servers may apply the bundle — otherwise a second foreign box would quietly
 * join a tunnel the user never pointed at it.
 */
function isTarget(targets, tunnel, server) {
  if (!server) return false;
  if (server.role === 'iran') {
    return tunnel?.targetServers?.iran ? targets.iran?.id === server.id : Boolean(targets.iran);
  }
  if (server.role === 'foreign') {
    const ids = foreignIds(tunnel);
    return ids.length ? targets.foreign.some((s) => s.id === server.id) : targets.foreign.length > 0;
  }
  return false;
}

module.exports = { foreignIds, resolveTargets, isTarget };
