'use strict';

/**
 * What "working" means for each template, and how to find out.
 *
 * The live harness puts both halves of a link inside Linux network
 * namespaces on one machine, runs the real WaterWall core on each side, and
 * then drives traffic through the entry point a user would actually connect
 * to. This table says where that entry point is and what it speaks.
 *
 *   entry:  'iran'  the Iran side has the listener users connect to
 *           'both'  the template is two independent forwarders, one per server
 *           null    no user-facing entry exists, so only a start-up test runs
 *   proto:  how the probe drives that listener
 *   reason: why a template has no traffic test (shown in the report)
 *
 * Every template gets a start-up test regardless: the real core must load the
 * generated config without a single error and every listener must bind. That
 * alone catches wrong node types, settings the core rejects, db-path and
 * certificate problems, and broken chain wiring.
 */

const LOAD_ONLY = (reason) => ({ entry: null, reason });

module.exports = {
  // --- two independent forwarders, one per server -------------------------
  'tcp-forward': { entry: 'both', proto: 'tcp' },
  'udp-forward': { entry: 'both', proto: 'udp' },
  'tcp-udp-forward': { entry: 'both', proto: 'tcp+udp' },

  // --- a listener on the Iran side, a real destination on the other -------
  'encrypted-tcp': { entry: 'iran', proto: 'tcp' },
  'xor-obfuscated': { entry: 'iran', proto: 'tcp' },
  'half-duplex': { entry: 'iran', proto: 'tcp' },
  'stream-fragmenter': { entry: 'iran', proto: 'tcp' },
  'connection-fisher': { entry: 'iran', proto: 'tcp' },
  'disturber-lab': { entry: 'iran', proto: 'tcp' },
  'tcp-over-udp': { entry: 'iran', proto: 'tcp' },
  'header-proxy': { entry: 'iran', proto: 'tcp' },

  // --- SOCKS5 entry, the exit dials whatever the client asked for ---------
  'vless-tls': { entry: 'iran', proto: 'socks5' },
  'vless-mux-tls': { entry: 'iran', proto: 'socks5' },
  'vless-reality': { entry: 'iran', proto: 'socks5' },
  'trojan-tls': { entry: 'iran', proto: 'socks5' },
  'vless-http-ws-tls': { entry: 'iran', proto: 'socks5' },
  'socks5-upstream': { entry: 'iran', proto: 'socks5' },
  'router-split': { entry: 'iran', proto: 'socks5' },
  'vless-hardened': { entry: 'iran', proto: 'socks5' },
  'auth-users': {
    entry: 'iran',
    proto: 'socks5-auth',
    // The Iran side authenticates through the far side's AuthenticationServer,
    // and the client pulls its user table on its own schedule. The very first
    // pull can land while the far side's listener is still coming up, in which
    // case the next one is a full interval away.
    probeSeconds: 75,
  },

  // --- UDP entry ----------------------------------------------------------
  'udp-over-tcp': { entry: 'iran', proto: 'udp' },

  // --- HTTP proxy entry ---------------------------------------------------
  'http-proxy': { entry: 'iran', proto: 'http' },

  // --- the foreign side dials out, so the user port is on the Iran side ---
  'reverse-tls': { entry: 'iran', proto: 'tcp' },
  'reverse-plain': { entry: 'iran', proto: 'tcp' },
  'reverse-reality': { entry: 'iran', proto: 'tcp' },

  // --- full-tunnel devices: everything the namespace sends goes through ---
  'tun-tcp-tunnel': { entry: 'iran-ns', proto: 'tun-web' },
  'tun-wireguard': { entry: 'iran-ns', proto: 'tun-web' },
  'tun2socks': { entry: 'iran-ns', proto: 'tun-web' },

  // --- raw-socket carriers that do have an endpoint on the far side -------
  'tcp-bit-swap-mux': { entry: 'iran', proto: 'tcp' },
  'tcp-bit-swap-mux-2': { entry: 'iran', proto: 'tcp' },

  // --- rootless WireGuard, SOCKS5 in and a real connect out ---------------
  // The listener has to be UDP-capable: the Socks5Server asks for `udp: true`
  // and resolves its relay from the node in front of it.
  'rootless-socks-wireguard': { entry: 'iran', proto: 'socks5' },

  // --- self-driving templates: they test themselves, we read the logs -----
  speedtest: {
    entry: null,
    proto: 'log',
    logPattern: 'SpeedTest',
    // The client runs a ten-second measurement before it reports anything.
    logSeconds: 30,
    reason: 'the client drives the test itself',
  },
  'tester-chain': { entry: null, proto: 'log', logPattern: 'Tester', reason: 'the tester node drives the test itself' },

  // --- carriers with no endpoint on the far side (see the report) ---------
  'tcp-bit-swap': LOAD_ONLY('carrier only — the far side receives packets but nothing accepts them'),
  protoswap: LOAD_ONLY('carrier only — the far side receives packets but nothing accepts them'),
  'first-sni': LOAD_ONLY('carrier only — the far side receives packets but nothing accepts them'),
  'sni-blender': LOAD_ONLY('carrier only — the far side receives packets but nothing accepts them'),
  'ping-tunnel': LOAD_ONLY('carrier only — the far side receives packets but nothing accepts them'),

  // --- needs infrastructure this harness cannot provide -------------------
  'cdn-reverse-wss': LOAD_ONLY('needs a real CDN in front; verified separately against ArvanCloud'),
};
