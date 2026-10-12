'use strict';

const crypto = require('node:crypto');
const { node, chainConfig } = require('../generator');
const { CERT_PATH, KEY_PATH } = require('../certs');

/** Generate a real X25519 keypair in the base64 form WaterWall expects. */
function wgKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const d = privateKey.export({ format: 'jwk' }).d;
  const x = publicKey.export({ format: 'jwk' }).x;
  return {
    privateKey: Buffer.from(d, 'base64url').toString('base64'),
    publicKey: Buffer.from(x, 'base64url').toString('base64'),
  };
}

/**
 * Shared helpers + the common `core.json` tuning fields that every template
 * exposes at the bottom of its form.
 */

const RAM_PROFILES = ['server', 'client', 'client-larger', 'minimal', 'ultralow'];
const DOMAIN_STRATEGIES = [
  'prefer-ipv4',
  'prefer-ipv6',
  'only-ipv4',
  'only-ipv6',
  'accept-dns-returned-order',
];
const LOG_LEVELS = ['VERBOSE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'SILENT'];

function coreFields(overrides = {}) {
  return [
    {
      key: '_core.workers',
      group: 'core',
      label: 'Worker threads',
      labelFa: 'تعداد ورکرها',
      type: 'number',
      default: 4,
      min: 1,
      max: 254,
      help: 'misc.workers — 0 or less means CPU core count. Higher is not always better.',
    },
    {
      key: '_core.ramProfile',
      group: 'core',
      label: 'Memory profile',
      labelFa: 'پروفایل حافظه',
      type: 'select',
      default: 'server',
      options: RAM_PROFILES,
      help: 'misc.ram-profile — "server" on the exit box, "client" on the entry box is a good default.',
    },
    {
      key: '_core.mtu',
      group: 'core',
      label: 'MTU',
      labelFa: 'MTU',
      type: 'number',
      default: 1500,
      min: 68,
      max: 65535,
      help: 'misc.mtu — use ~1280 for packet/TUN/WireGuard chains.',
    },
    {
      key: '_core.logLevel',
      group: 'core',
      label: 'Log level',
      labelFa: 'سطح لاگ',
      type: 'select',
      default: 'INFO',
      options: LOG_LEVELS,
    },
    {
      key: '_core.networkLogLevel',
      group: 'core',
      label: 'Network log level',
      labelFa: 'لاگ شبکه',
      type: 'select',
      default: 'INFO',
      options: LOG_LEVELS,
    },
    {
      key: '_core.domainStrategy',
      group: 'core',
      label: 'Domain strategy',
      labelFa: 'استراتژی دامنه',
      type: 'select',
      default: 'prefer-ipv4',
      options: DOMAIN_STRATEGIES,
      help: 'dns.domain-strategy — must live under "dns", not at the root of core.json.',
    },
    {
      key: '_core.dnsServers',
      group: 'core',
      label: 'DNS servers',
      labelFa: 'سرورهای DNS',
      type: 'list',
      default: [],
      placeholder: '1.1.1.1',
      help: 'Optional. Leave empty to use the system/c-ares defaults.',
    },
    {
      key: '_core.splice',
      group: 'core',
      label: 'Allow splice(2)',
      labelFa: 'فعال بودن splice',
      type: 'boolean',
      default: true,
      help: 'misc.splice — faster zero-copy streams on Linux, ignored for packet chains.',
    },
    {
      key: '_core.bbr',
      group: 'core',
      label: 'Try enabling BBR',
      labelFa: 'فعال‌سازی BBR',
      type: 'boolean',
      default: true,
      help: 'misc.try-enabling-bbr — best-effort live sysctl on Linux only.',
    },
    ...(overrides.coreFields || []),
  ];
}

/** Turn `_core.*` options into a `bundleCore` opts object. */
function coreOpts(options, defaults = {}) {
  const core = options._core || {};
  const split = (value) =>
    typeof value === 'string'
      ? value.split(/[\s,]+/).filter(Boolean)
      : Array.isArray(value)
        ? value
        : [];
  return {
    workers: core.workers ?? defaults.workers ?? 2,
    ramProfile: core.ramProfile || defaults.ramProfile || 'server',
    mtu: core.mtu ?? defaults.mtu ?? 1500,
    logLevel: core.logLevel || defaults.logLevel || 'INFO',
    networkLogLevel: core.networkLogLevel || defaults.networkLogLevel || 'INFO',
    domainStrategy: core.domainStrategy || defaults.domainStrategy || 'prefer-ipv4',
    dnsServers: split(core.dnsServers),
    splice: core.splice !== false,
    bbr: core.bbr !== false,
  };
}

/** Common "which host do we connect to" behaviour for the exit side. */
function destFields(defaults = {}) {
  return [
    {
      key: 'destAddress',
      group: 'destination',
      label: 'Destination address',
      labelFa: 'آدرس مقصد',
      type: 'text',
      default: defaults.destAddress || 'example.com',
      required: true,
      help: 'Host or IP that the exit side connects to for every accepted request.',
    },
    {
      key: 'destPort',
      group: 'destination',
      label: 'Destination port',
      labelFa: 'پورت مقصد',
      type: 'number',
      default: defaults.destPort || 80,
      min: 1,
      max: 65535,
      required: true,
    },
  ];
}

function listenFields(defaults = {}) {
  return [
    {
      key: 'listenAddress',
      group: 'listen',
      label: 'Listen address',
      labelFa: 'آدرس شنود',
      type: 'text',
      default: defaults.listenAddress || '0.0.0.0',
      help: 'Use 0.0.0.0 for public listeners; 127.0.0.1 for entry-side-only listeners.',
    },
    {
      key: 'listenPort',
      group: 'listen',
      label: 'Listen port',
      labelFa: 'پورت شنود',
      type: 'number',
      default: defaults.listenPort || 8080,
      min: 1,
      max: 65535,
      required: true,
    },
    {
      key: 'nodelay',
      group: 'listen',
      label: 'TCP_NODELAY',
      labelFa: 'TCP_NODELAY',
      type: 'boolean',
      default: true,
    },
  ];
}

// ------------------------------------------------------ protocol helpers

const CIPHERS = ['chacha20-poly1305', 'chacha20poly1305', 'aes-gcm', 'aes-256-gcm', 'aes256gcm'];

/**
 * TLS fields: the certificate the panel can issue, plus the client side.
 *
 * Filling in `domain` and leaving `certMode` on "auto" is the whole workflow:
 * apply the tunnel and the certificate is issued or renewed as needed before the
 * config is written. With no domain the panel leaves the existing paths alone,
 * which is what you want when a certificate is already installed by hand.
 */
function tlsFields({ sni = 'example.com', certPath = CERT_PATH, keyPath = KEY_PATH } = {}) {
  return [
    {
      key: 'domain',
      group: 'tls',
      label: 'Domain for an automatic certificate',
      labelFa: 'دامنه برای ساخت خودکار گواهی',
      type: 'text',
      default: '',
      help:
        'اگر پر شود، پنل هنگام اعمال تونل گواهی می‌سازد یا تمدید می‌کند. خالی بگذارید تا از گواهی نصب‌شده استفاده شود.',
    },
    {
      key: 'certMode',
      group: 'tls',
      label: 'How to obtain the certificate',
      labelFa: 'روش تهیه گواهی',
      type: 'select',
      default: 'auto',
      options: ['auto', 'letsencrypt', 'self-signed', 'none'],
      when: { domain: [(v) => Boolean(String(v || '').trim())] },
      help:
        'auto: اگر دامنه به IP این سرور اشاره کند از Let\'s Encrypt می‌گیرد، وگرنه خودامضا می‌سازد. letsencrypt: فقط CA واقعی و در صورت شکست خطا می‌دهد.',
    },
    {
      key: 'certEmail',
      group: 'tls',
      label: 'Email for Let\'s Encrypt',
      labelFa: 'ایمیل برای Let\'s Encrypt',
      type: 'text',
      default: '',
      when: { domain: [(v) => Boolean(String(v || '').trim())] },
    },
    { key: 'sni', group: 'tls', label: 'SNI / server name', labelFa: 'SNI', type: 'text', default: sni, required: true, help: 'TlsClient.settings.sni — must match the certificate on the foreign side.' },
    {
      key: 'verify',
      group: 'tls',
      label: 'Verify certificate',
      labelFa: 'بررسی گواهی',
      type: 'boolean',
      default: true,
      help: 'TlsClient.settings.verify — keep true in production; only disable while testing a self-signed certificate.',
    },
    { key: 'alpns', group: 'tls', label: 'ALPNs', labelFa: 'ALPN', type: 'list', default: ['h2', 'http/1.1'], help: 'TlsClient.settings.alpns. JSON order is preserved in the ClientHello.' },
    {
      key: 'certPath',
      group: 'tls',
      label: 'Certificate path (foreign)',
      labelFa: 'مسیر گواهی (خارج)',
      type: 'text',
      default: certPath,
      required: true,
      help: 'TlsServer.settings.cert-file — the panel writes here when a domain is set.',
    },
    {
      key: 'keyPath',
      group: 'tls',
      label: 'Private key path (foreign)',
      labelFa: 'مسیر کلید (خارج)',
      type: 'text',
      default: keyPath,
      required: true,
      help: 'TlsServer.settings.key-file.',
    },
    { key: 'selectAlpns', group: 'tls', label: 'ALPNs accepted (foreign)', labelFa: 'ALPN مجاز (خارج)', type: 'list', default: ['h2', 'http/1.1'] },
    { key: 'tlsMinVersion', group: 'tls', label: 'Min TLS version', labelFa: 'کمینه نسخه TLS', type: 'select', default: 'TLSv1.2', options: ['TLSv1.2', 'TLSv1.3'] },
    { key: 'tlsMaxVersion', group: 'tls', label: 'Max TLS version', labelFa: 'بیشینه نسخه TLS', type: 'select', default: 'TLSv1.3', options: ['TLSv1.2', 'TLSv1.3'] },
    { key: 'sessionCache', group: 'tls', label: 'Session cache', labelFa: 'کش نشست', type: 'select', default: 'none', options: ['none', 'off', 'builtin', 'builtin:20480'] },
  ];
}

/** Reality v2 — note: WaterWall's Reality is password-based, not key-based. */
function realityFields(defaults = {}) {
  return [
    {
      key: 'realityPassword',
      group: 'reality',
      label: 'Reality password',
      labelFa: 'رمز Reality',
      type: 'password',
      default: 'auto:password16',
      required: true,
      help: 'RealityClient/RealityServer.settings.password — 1..32 UTF-8 bytes. Must match on both sides. WaterWall Reality authenticates with a shared password, not a public/private key pair.',
    },
    {
      key: 'realitySalt',
      group: 'reality',
      label: 'Reality salt',
      labelFa: 'Salt Reality',
      type: 'text',
      default: 'waterwall-reality',
      help: 'Leave at the default to match WaterWall. Both sides must be identical.',
    },
    {
      key: 'realityAlgorithm',
      group: 'reality',
      label: 'Reality algorithm',
      labelFa: 'الگوریتم Reality',
      type: 'select',
      default: 'chacha20-poly1305',
      options: CIPHERS,
    },
    {
      key: 'realityKdf',
      group: 'reality',
      label: 'Reality KDF iterations',
      labelFa: 'تکرار KDF Reality',
      type: 'number',
      default: 12000,
      min: 1,
      max: 1000000,
    },
    {
      key: 'camouflageHost',
      group: 'reality',
      label: 'Camouflage destination',
      labelFa: 'مقصد استتار',
      type: 'text',
      default: defaults.camouflageHost || 'www.microsoft.com',
      required: true,
      help: 'RealityServer.settings.destination points at a node that forwards ordinary visitors here. Must be a real HTTPS site reachable from the server.',
    },
    {
      key: 'camouflagePort',
      group: 'reality',
      label: 'Camouflage port',
      labelFa: 'پورت استتار',
      type: 'number',
      default: 443,
      min: 1,
      max: 65535,
    },
    {
      key: 'realitySni',
      group: 'reality',
      label: 'Visitor SNI',
      labelFa: 'SNI بازدیدکننده',
      type: 'text',
      default: defaults.realitySni || 'www.microsoft.com',
      required: true,
      help: 'RealityClient.settings.sni — the SNI a normal visitor would send. Must match camouflageHost for the handshake to verify.',
    },
    {
      key: 'sniffingAttempts',
      group: 'reality',
      label: 'Sniffing attempts',
      labelFa: 'تعداد تلاش sniffing',
      type: 'number',
      default: 8,
      min: 1,
      max: 1024,
    },
  ];
}

/** MuxClient mode selector. MuxServer takes no required settings. */
function muxFields(defaults = {}) {
  return [
    {
      key: 'muxMode',
      group: 'mux',
      label: 'Mux mode',
      labelFa: 'حالت Mux',
      type: 'select',
      default: defaults.muxMode || 'timer',
      options: ['timer', 'counter', 'fixed-connections-count'],
      help: 'MuxClient.settings.mode — "timer" rotates transports, "counter" caps children per parent, "fixed-connections-count" opens a fixed number per worker.',
    },
    { key: 'muxConnectionDurationMs', group: 'mux', label: 'Connection duration (ms)', labelFa: 'مدت اتصال', type: 'number', default: 30000, min: 61, help: 'Required when mode = timer. WaterWall rejects values <= 60.', when: { muxMode: 'timer' } },
    { key: 'muxConnectionCapacity', group: 'mux', label: 'Connection capacity', labelFa: 'ظرفیت اتصال', type: 'number', default: 128, min: 1, help: 'Required when mode = counter.', when: { muxMode: 'counter' } },
    { key: 'muxPerWorkerConnections', group: 'mux', label: 'Connections per worker', labelFa: 'اتصال به ازای هر ورکر', type: 'number', default: 2, min: 1, help: 'Required when mode = fixed-connections-count.', when: { muxMode: 'fixed-connections-count' } },
    { key: 'muxMaxChildren', group: 'mux', label: 'Max children', labelFa: 'حداکثر فرزند', type: 'number', default: 10000, min: 1 },
  ];
}

function vlessFields(defaults = {}) {
  return [
    {
      key: 'uuid',
      group: 'vless',
      label: 'VLESS UUID',
      labelFa: 'شناسه کاربر VLESS',
      type: 'text',
      default: defaults.uuid || 'auto:uuid',
      required: true,
      help: 'VlessServer.settings.uuid. Dashed RFC4122 or compact 32-char hex. Add more by separating with commas.',
    },
    { key: 'connectCmd', group: 'vless', label: 'Allow CONNECT (TCP)', labelFa: 'اجازه CONNECT', type: 'boolean', default: true },
    { key: 'udpCmd', group: 'vless', label: 'Allow UDP associate', labelFa: 'اجازه UDP', type: 'boolean', default: true },
    { key: 'vlessDomainStrategy', group: 'vless', label: 'Client domain strategy', labelFa: 'استراتژی دامنه کلاینت', type: 'select', default: 'do-not-resolve-domains', options: ['do-not-resolve-domains', 'resolve-domains-with-core-settings', 'resolve-domains-and-prefer-ipv4', 'resolve-domains-and-use-only-ipv4'] },
  ];
}

function trojanFields(defaults = {}) {
  return [
    { key: 'trojanPassword', group: 'trojan', label: 'Trojan password', labelFa: 'رمز تراجان', type: 'password', default: defaults.trojanPassword || 'auto:password', required: true, help: 'TrojanServer.settings.password — may be a raw password or a precomputed SHA224 hex.' },
    { key: 'trojanConnect', group: 'trojan', label: 'Allow CONNECT (TCP)', labelFa: 'اجازه CONNECT', type: 'boolean', default: true },
    { key: 'trojanUdp', group: 'trojan', label: 'Allow UDP associate', labelFa: 'اجازه UDP', type: 'boolean', default: true },
  ];
}

/** Parse a comma separated option into an array. */
function csv(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Build a share link for a client app. */
function link({ protocol, host, port, params = {}, fragment }) {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${protocol}://${host}:${port}${query ? `?${query}` : ''}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`;
}

module.exports = {
  coreFields,
  coreOpts,
  destFields,
  listenFields,
  tlsFields,
  realityFields,
  muxFields,
  vlessFields,
  trojanFields,
  wgKeypair,
  node,
  chainConfig,
  csv,
  link,
  RAM_PROFILES,
  DOMAIN_STRATEGIES,
  LOG_LEVELS,
  CIPHERS,
};
