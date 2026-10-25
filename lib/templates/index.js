'use strict';

const basic = require('./basic');
const stream = require('./stream');
const proxy = require('./proxy');
const layer3 = require('./layer3');
const reverse = require('./reverse');
const reverseReality = require('./reverse-reality');
const relay = require('./relay');
const bitswap = require('./bitswap');
const protoswap = require('./protoswap');
const streamAdv = require('./stream-adv');
const l3New = require('./l3-new');
const stealth = require('./stealth');
const transport = require('./transport');
const ops = require('./ops');
const cdn = require('./cdn');
const cdnSplit = require('./cdn-split');

const ALL = [
  ...basic,
  ...stream,
  ...proxy,
  ...layer3,
  ...reverse,
  ...reverseReality,
  ...relay,
  ...bitswap,
  ...protoswap,
  ...streamAdv,
  ...l3New,
  ...stealth,
  ...transport,
  ...ops,
  ...cdn,
  ...cdnSplit,
];

const byId = new Map(ALL.map((t) => [t.id, t]));

/**
 * One icon set for the whole catalogue.
 *
 * The templates each carried their own emoji, and the result was a wall of
 * forty cards with eight different blues and a couple of animals in the
 * middle. A single, restrained set reads as one product: every scenario is a
 * small glyph on a rounded tile, and the *category* is what tells them
 * apart at a glance.
 *
 * The mapping is by template id, so the icon a scenario shows can be changed
 * here without touching the template files.
 */
const ICONS = {
  // base — plain port forwarding
  'tcp-forward': '⇄',
  'udp-forward': '⇅',
  'tcp-udp-forward': '⇆',
  'encrypted-tcp': '🔒',
  'xor-obfuscated': '▨',
  'tcp-relay': '⇉',

  // protocols — what the client speaks
  'vless-tls': '⬡',
  'vless-mux-tls': '⬢',
  'vless-reality': '◈',
  'trojan-tls': '⚉',
  'vless-http-ws-tls': '⬝',
  'udp-over-tcp': '▣',
  'socks5-reality-mux': '⬣',
  'header-proxy': '▤',

  // proxies
  'http-proxy': '⬦',
  'socks5-upstream': '⬧',

  // layer 3 — whole-system traffic
  'tun-wireguard': '⬔',
  'rootless-socks-tcp': '⬕',
  'tun-tcp-tunnel': '⬖',
  tun2socks: '⬗',

  // reverse, relay and CDN — the operational scenarios
  'reverse-tls': '⇋',
  'reverse-plain': '⇆',
  'reverse-reality': '◉',
  'relay-reality': '⇹',
  'cdn-reverse-wss': '☁',
  'cdn-reverse-split': '☁',
  'auth-users': '⬙',
  'router-split': '⬚',
  'vless-hardened': '⬛',
  'disturber-lab': '⬜',
  speedtest: '▩',
  'tester-chain': '▨',

  // anti-DPI
  'tcp-bit-swap': '◐',
  'tcp-bit-swap-mux': '◑',
  'tcp-bit-swap-mux-2': '◒',
  protoswap: '◓',
  'stream-fragmenter': '✂',
  'ping-tunnel': '◌',
  'first-sni': '◍',
  'sni-blender': '◎',

  // resilience
  'half-duplex': '◐',
  'connection-fisher': '⑂',
  'tcp-over-udp': '⬓',
};

/** The icon a template shows in the catalogue. */
function iconFor(tpl) {
  return ICONS[tpl.id] || tpl.icon || '⬢';
}

function get(id) {
  return byId.get(id) || null;
}

/** Catalog entry used by the UI form builder (no build function). */
function catalogEntry(tpl) {
  return {
    id: tpl.id,
    title: tpl.title,
    titleFa: tpl.titleFa || tpl.title,
    category: tpl.category,
    categoryFa: tpl.categoryFa || tpl.category,
    icon: iconFor(tpl),
    sides: tpl.sides,
    summary: tpl.summary,
    summaryFa: tpl.summaryFa || tpl.summary,
    docs: tpl.docs || null,
    fieldGroups: tpl.fieldGroups || null,
    fields: tpl.fields || [],
    clientHint: tpl.clientHint || null,
    tags: tpl.tags || [],
    // Surfaces "needs WaterWall x.y.z" in the picker so nobody deploys a
    // template their core cannot load.
    minVersion: tpl.minVersion || null,
    // Reverse entries can point at any number of exit servers.
    multiExit: tpl.multiExit === true,
  };
}

function catalog() {
  return ALL.map(catalogEntry);
}

module.exports = { ALL, get, catalog, catalogEntry };
