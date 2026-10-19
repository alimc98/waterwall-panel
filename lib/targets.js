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
 *
 * The relay side is deliberately explicit-only: adding a relay server to the
 * panel must not quietly turn every existing two-sided tunnel into a three-sided
 * one. A tunnel that uses a relay names it in `targetServers.relay`.
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
  const relay = byId(tunnel?.targetServers?.relay) || null;
  return { iran, foreign, relay };
}

/** The concrete server fleet for one side of a tunnel. */
function targetsForSide(targets, side) {
  if (side === 'iran') return targets.iran ? [targets.iran] : [];
  if (side === 'relay') return targets.relay ? [targets.relay] : [];
  return targets.foreign || [];
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
  if (server.role === 'relay') {
    // Relays are always explicit. Falling back to "the first relay server"
    // would deploy a third-hop tunnel to a box the user never selected.
    return tunnel?.targetServers?.relay ? targets.relay?.id === server.id : false;
  }
  if (server.role === 'foreign') {
    const ids = foreignIds(tunnel);
    return ids.length ? targets.foreign.some((s) => s.id === server.id) : targets.foreign.length > 0;
  }
  return false;
}

module.exports = { foreignIds, resolveTargets, targetsForSide, isTarget };
