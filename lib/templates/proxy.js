'use strict';

const {chainConfig, coreFields, coreOpts, csv, listenPorts, node, tlsFields, vlessFields} = require('./common');

/**
 * Proxy-flavoured entry points. The Iran side always terminates a local proxy
 * protocol; the foreign side either reaches the internet directly or forwards
 * to another upstream proxy.
 */

const j = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

const httpProxy = {
  id: 'http-proxy',
  title: 'HTTP Proxy over VLESS+TLS',
  titleFa: 'پروکسی HTTP روی VLESS+TLS',
  category: 'proxy',
  categoryFa: 'پروکسی',
  icon: '🌐',
  sides: ['iran', 'foreign'],
  listenPorts: listenPorts({
    iran: ['listenPort'],
    foreign: ['publicPort'],
    relay: [],
    pairs: [],
  }),
  summary: 'TcpListener -> HttpProxyServer -> VlessClient -> TlsClient -> TcpConnector. Local apps get a real HTTP proxy (CONNECT + plain HTTP).',
  summaryFa: 'برنامه‌های محلی یک پروکسی HTTP واقعی می‌گیرند؛ ترافیک از تونل VLESS/TLS عبور می‌کند و روی سرور خارج به مقصد وصل می‌شود.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/HttpProxyServer',
  tags: ['http-proxy', 'vless', 'tls'],
  fields: [
    { key: 'listenAddress', group: 'entry', label: 'Local listen address', labelFa: 'آدرس شنود محلی', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'entry', label: 'Local HTTP proxy port', labelFa: 'پورت پروکسی', type: 'number', default: 8080, min: 1, max: 65535, required: true },
    { key: 'publicPort', group: 'entry', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    ...vlessFields(),
    ...tlsFields(),
    ...coreFields(),
  ],
  build({ options }) {
    // Every key here must exist in the node's own settings table: WaterWall
    // rejects unknown, duplicate or conflicting settings at startup
    // ("invalid settings, authentication selection, or missing next node"),
    // and `connect` is a Socks5Server setting, not an HttpProxyServer one.
    const serverSettings = {
      'max-header-bytes': 32768,
      'max-pending-bytes': 262144,
      'header-timeout-ms': 15000,
      'connect-timeout-ms': 30000,
      'idle-timeout-ms': 300000,
    };
    // HttpProxyServer accepts an explicit `no-auth: true` or an
    // AuthenticationClient named by `auth-client-node-name`. WaterWall
    // 1.46.96 dropped the inline `users` array from it the same way it
    // dropped it from Socks5Server, and a bad auth selection is a startup
    // failure ("invalid settings, authentication selection, or missing next
    // node") that takes the whole core down — not just this listener.
    serverSettings['no-auth'] = true;

    const iranNodes = [
      node('local', 'TcpListener', { address: options.listenAddress, port: Number(options.listenPort), nodelay: true }, 'proxy'),
      node('proxy', 'HttpProxyServer', serverSettings, 'crypt'),
      node('crypt', 'VlessClient', {
        uuid: csv(options.uuid).join(','),
        'target-address': 'dest_context->address',
        port: 'dest_context->port',
        protocol: 'dest_context->protocol',
      }, 'tls'),
      node('tls', 'TlsClient', { sni: options.sni, verify: options.verify !== false, alpns: csv(options.alpns) }, 'out'),
      node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }),
    ];

    const foreignNodes = [
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, 'tls'),
      node('tls', 'TlsServer', {
        'cert-file': options.certPath,
        'key-file': options.keyPath,
        sni: options.sni,
        'select-alpns': csv(options.selectAlpns).length ? csv(options.selectAlpns) : ['h2', 'http/1.1'],
        'min-version': options.tlsMinVersion,
        'max-version': options.tlsMaxVersion,
      }, 'auth'),
      node('auth', 'VlessServer', { uuid: csv(options.uuid).join(','), connect: true, udp: true }, 'out'),
      node('out', 'TcpConnector', { address: 'dest_context->address', port: 'dest_context->port', nodelay: true }),
    ];

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/http-proxy.json': j(chainConfig('http-proxy-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/http-proxy.json': j(chainConfig('http-proxy-foreign', foreignNodes)) } },
      client: {
        // HttpProxyServer has no per-user credentials on WaterWall 1.46.96 —
        // inline `users` was removed from it — so the proxy is open to anyone
        // who can reach the port and there is no user:pass URL to print.
        links: [{ label: 'HTTP proxy (سرور ایران)', url: `http://${options.iranHost}:${options.listenPort}` }],
        instructions: [
          'در تنظیمات مرورگر یا سیستم، پروکسی HTTP را روی آدرس سرور ایران و پورت شنود بگذارید.',
          'HttpProxyServer هر دو حالت CONNECT و درخواست HTTP/1.x را پشتیبانی می‌کند.',
        ],
      },
      warnings: [
        'HttpProxyServer does not forward UDP. Use the SOCKS5 or VLESS templates when you need UDP.',
        'این پروکسی بدون نام کاربری و رمز است؛ پورت را با فایروال محدود نگه دارید یا برای احراز هویت کاربران از قالب «auth-users» استفاده کنید.',
      ],
    };
  },
};

const socks5Upstream = {
  id: 'socks5-upstream',
  title: 'Tunnel + upstream SOCKS5',
  titleFa: 'تونل به‌علاوه SOCKS5 بالادست',
  category: 'proxy',
  categoryFa: 'پروکسی',
  icon: '🪜',
  sides: ['iran', 'foreign'],
  listenPorts: listenPorts({
    iran: ['listenPort'],
    foreign: ['publicPort'],
    relay: [],
    pairs: [],
  }),
  summary: 'Foreign side reaches the internet through another SOCKS5 proxy: TlsServer -> VlessServer -> Socks5Client -> TcpConnector.',
  summaryFa: 'خروج ترافیک از یک پروکسی SOCKS5 دیگر انجام می‌شود؛ مفید برای زنجیره‌کردن چند سرور یا استفاده از IP ثابت دیگر.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/Socks5Client',
  tags: ['socks5', 'chain', 'vless'],
  fields: [
    { key: 'listenAddress', group: 'entry', label: 'Local listen address', labelFa: 'آدرس شنود محلی', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'entry', label: 'Local SOCKS5 port', labelFa: 'پورت SOCKS5 محلی', type: 'number', default: 1080, min: 1, max: 65535, required: true },
    { key: 'socksUdp', group: 'entry', label: 'Enable UDP', labelFa: 'UDP', type: 'boolean', default: true },
    { key: 'socksAdvertiseIp', group: 'entry', label: 'UDP advertise IPv4', labelFa: 'آدرس اعلامی UDP', type: 'text', default: '' },
    { key: 'publicPort', group: 'entry', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    ...vlessFields(),
    ...tlsFields(),
    { key: 'upstreamHost', group: 'upstream', label: 'Upstream SOCKS5 host', labelFa: 'آدرس SOCKS5 بالادست', type: 'text', default: '', required: true, help: 'The SOCKS5 proxy the foreign server connects out through. Leave empty to connect straight to the internet.' },
    { key: 'upstreamPort', group: 'upstream', label: 'Upstream SOCKS5 port', labelFa: 'پورت SOCKS5 بالادست', type: 'number', default: 1080, min: 1, max: 65535, when: { upstreamHost: '*' } },
    { key: 'upstreamUser', group: 'upstream', label: 'Upstream username', labelFa: 'کاربر بالادست', type: 'text', default: '' },
    { key: 'upstreamPass', group: 'upstream', label: 'Upstream password', labelFa: 'رمز بالادست', type: 'password', default: '' },
    ...coreFields(),
  ],
  build({ options }) {
    const iranNodes = [
      node('local', 'TcpUdpListener', { address: options.listenAddress, port: Number(options.listenPort), nodelay: true, 'large-send-buffer': true, 'large-recv-buffer': true }, 'socks'),
      node('socks', 'Socks5Server', {
        // Inline `users` was removed in 1.46.96; see entrySocks in stream.js.
        'no-auth': true,
        connect: true,
        udp: options.socksUdp !== false,
        ...(options.socksUdp !== false ? { 'udp-ipv4': options.socksAdvertiseIp || options.iranHost || '127.0.0.1' } : {}),
      }, 'crypt'),
      node('crypt', 'VlessClient', {
        uuid: csv(options.uuid).join(','),
        'target-address': 'dest_context->address',
        port: 'dest_context->port',
        protocol: 'dest_context->protocol',
      }, 'tls'),
      node('tls', 'TlsClient', { sni: options.sni, verify: options.verify !== false, alpns: csv(options.alpns) }, 'out'),
      node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }),
    ];

    const foreignNodes = [
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, 'tls'),
      node('tls', 'TlsServer', {
        'cert-file': options.certPath,
        'key-file': options.keyPath,
        sni: options.sni,
        'select-alpns': csv(options.selectAlpns).length ? csv(options.selectAlpns) : ['h2', 'http/1.1'],
        'min-version': options.tlsMinVersion,
        'max-version': options.tlsMaxVersion,
      }, 'auth'),
      node('auth', 'VlessServer', { uuid: csv(options.uuid).join(','), connect: true, udp: true }, options.upstreamHost ? 'upstream-socks' : 'out'),
    ];

    if (options.upstreamHost) {
      const socksClient = {
        address: 'dest_context->address',
        port: 'dest_context->port',
        protocol: 'dest_context->protocol',
        'domain-strategy': 'do-not-resolve-domains',
      };
      if (options.upstreamUser) {
        socksClient.user = options.upstreamUser;
        socksClient.pass = options.upstreamPass;
      }
      foreignNodes.push(node('upstream-socks', 'Socks5Client', socksClient, 'upstream-out'));
      foreignNodes.push(
        node('upstream-out', 'TcpConnector', {
          address: options.upstreamHost,
          port: Number(options.upstreamPort) || 1080,
          nodelay: true,
        }),
      );
    } else {
      foreignNodes.push(node('out', 'TcpConnector', { address: 'dest_context->address', port: 'dest_context->port', nodelay: true }));
    }

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/socks-upstream.json': j(chainConfig('socks-upstream-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/socks-upstream.json': j(chainConfig('socks-upstream-foreign', foreignNodes)) } },
      client: { links: [{ label: 'SOCKS5 (روی سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}` }] },
      notes: options.upstreamHost
        ? [`Exit path: ${options.foreignHost} → SOCKS5 ${options.upstreamHost}:${options.upstreamPort} → destination`]
        : ['No upstream configured: the foreign server connects straight to the internet.'],
      warnings: ['Socks5Client needs both "user" and "pass" together; leaving one empty disables auth.'],
    };
  },
};

module.exports = [httpProxy, socks5Upstream];
