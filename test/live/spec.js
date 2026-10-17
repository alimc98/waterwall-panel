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

  // --- mux carriers built on the tcp-bit-swap packet machinery ------------
  // The verbose run shows the same carrier limitation as tcp-bit-swap below:
  // the TUN / raw-socket / NFQUEUE path moves a few frames and then the far
  // side drops them ("TunDevice: dropping malformed or unsupported IP input").
  // Spoofed 12.12.12.x / 12.13.12.x packets cannot make that trip through
  // NFQUEUE inside a nested namespace the way they would between two real
  // servers, so only loading is verified here.
  'tcp-bit-swap-mux': LOAD_ONLY('carrier only — same packet machinery as tcp-bit-swap, which cannot complete inside the namespace harness'),
  'tcp-bit-swap-mux-2': LOAD_ONLY('carrier only — same packet machinery as tcp-bit-swap, which cannot complete inside the namespace harness'),

  // --- rootless SOCKS5, a real connect out, no TUN anywhere ----------------
  // The listener has to be UDP-capable: the Socks5Server asks for `udp: true`
  // and resolves its relay from the node in front of it. The transport is the
  // same packets-over-TLS pair that tun-tcp-tunnel proves; the WireGuard
  // variant of this chain cannot receive on its transport side (the core only
  // feeds WireGuardDevice from a chain-head UdpStatelessSocket).
  'rootless-socks-tcp': { entry: 'iran', proto: 'socks5' },

  // --- self-driving templates: they test themselves, we read the logs -----
  speedtest: {
    entry: null,
    proto: 'log',
    // The client prints one JSON summary when the run is over; a failure line
    // contains the node name too, so the pattern has to name the success.
    logPattern: 'SpeedTestClient: json-summary.*"success":true',
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
