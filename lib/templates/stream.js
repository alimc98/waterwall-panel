'use strict';

const {
  coreFields,
  coreOpts,
  destFields,
  tlsFields,
  realityFields,
  muxFields,
  vlessFields,
  trojanFields,
  node,
  chainConfig,
  csv,
  link,
} = require('./common');

/**
 * Protocol streams. The "Iran" side is the WaterWall *client* chain that
 * accepts local users (SOCKS5 / plain TCP) and the "foreign" side is the
 * *server* chain that terminates the protocol and forwards to the internet.
 */

const j = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

/** Entry-side listener: a local SOCKS5 (with UDP) or a plain TCP listener. */
function entryListener(options) {
  if (options.entryMode === 'tcp') {
    return node(
      'local',
      'TcpListener',
      { address: options.listenAddress || '0.0.0.0', port: Number(options.listenPort), nodelay: true },
      'socks',
    );
  }
  return node(
    'local',
    'TcpUdpListener',
    {
      address: options.listenAddress || '0.0.0.0',
      port: Number(options.listenPort),
      nodelay: true,
      'large-send-buffer': true,
      'large-recv-buffer': true,
    },
    'socks',
  );
}

function entrySocks(options, next) {
  if (options.entryMode === 'tcp') return null; // no SOCKS5 layer, go straight to the protocol node
  const settings = {
    'no-auth': options.socksAuth === 'password',
    connect: true,
    udp: options.socksUdp !== false,
  };
  if (settings.udp) settings['udp-ipv4'] = options.socksAdvertiseIp || options.iranHost || '127.0.0.1';
  if (options.socksAuth === 'password') {
    settings['no-auth'] = false;
    settings.users = [{ username: options.socksUsername || 'user', password: options.socksPassword || 'auto:password' }];
  }
  return node('socks', 'Socks5Server', settings, next);
}

const ENTRY_FIELDS = [
  {
    key: 'entryMode',
    group: 'entry',
    label: 'Local entry point',
    labelFa: 'نقطه ورود محلی',
    type: 'select',
    default: 'socks5',
    options: ['socks5', 'tcp'],
    help: 'socks5 = a SOCKS5 proxy for local apps (needs TcpUdpListener for UDP). tcp = raw TCP forward, any app can use it.',
  },
  { key: 'listenAddress', group: 'entry', label: 'Local listen address', labelFa: 'آدرس شنود محلی', type: 'text', default: '0.0.0.0', help: 'Use 127.0.0.1 if only the Iran box itself should use it.' },
  { key: 'listenPort', group: 'entry', label: 'Local listen port', labelFa: 'پورت شنود محلی', type: 'number', default: 1080, min: 1, max: 65535, required: true },
  { key: 'socksAuth', group: 'entry', label: 'SOCKS5 auth', labelFa: 'احراز هویت SOCKS5', type: 'select', default: 'none', options: ['none', 'password'] },
  { key: 'socksUsername', group: 'entry', label: 'SOCKS5 username', labelFa: 'نام کاربری', type: 'text', default: 'user', when: { socksAuth: 'password' } },
  { key: 'socksPassword', group: 'entry', label: 'SOCKS5 password', labelFa: 'رمز عبور', type: 'password', default: 'auto:password', when: { socksAuth: 'password' } },
  { key: 'socksUdp', group: 'entry', label: 'Enable SOCKS5 UDP', labelFa: 'UDP در SOCKS5', type: 'boolean', default: true, when: { entryMode: 'socks5' } },
  { key: 'socksAdvertiseIp', group: 'entry', label: 'UDP advertise IPv4', labelFa: 'آدرس اعلامی UDP', type: 'text', default: '', help: 'Socks5Server udp-ipv4: the reachable IPv4 handed back in UDP ASSOCIATE. Defaults to the Iran server IP.', when: { socksUdp: true } },
  { key: 'publicPort', group: 'entry', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
];

function destConnector(extra = {}) {
  return node('out', 'TcpConnector', {
    address: 'dest_context->address',
    port: 'dest_context->port',
    nodelay: true,
    ...extra,
  });
}

// -------------------------------------------------------------------------
const vlessTls = {
  id: 'vless-tls',
  title: 'VLESS over TLS',
  titleFa: 'VLESS روی TLS',
  category: 'stream',
  categoryFa: 'پروتکل',
  icon: '🛡️',
  sides: ['iran', 'foreign'],
  summary: 'Socks5Server -> VlessClient -> TlsClient -> TcpConnector  /  TcpListener -> TlsServer -> VlessServer -> TcpConnector',
  summaryFa: 'ورودی SOCKS5 در ایران، رمزنگاری TLS، VLESS، و خروج به اینترنت از سرور خارج. نیازمند گواهی SSL معتبر.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/VlessClient',
  tags: ['vless', 'tls', 'socks5'],
  fields: [
    ...ENTRY_FIELDS,
    ...vlessFields(),
    ...tlsFields(),
    ...coreFields(),
  ],
  build(ctx) {
    const { options, tunnel } = ctx;
    const iranNodes = [];
    iranNodes.push(entryListener(options));
    const socks = entrySocks(options, 'crypt');
    if (socks) iranNodes.push(socks);
    iranNodes.push(
      node('crypt', 'VlessClient', {
        uuid: csv(options.uuid).join(','),
        'target-address': 'dest_context->address',
        port: 'dest_context->port',
        protocol: 'dest_context->protocol',
        'domain-strategy': options.vlessDomainStrategy || 'do-not-resolve-domains',
      }, 'tls'),
    );
    iranNodes.push(
      node('tls', 'TlsClient', {
        sni: options.sni,
        verify: options.verify !== false,
        alpns: csv(options.alpns).length ? csv(options.alpns) : ['h2', 'http/1.1'],
      }, 'out'),
    );
    iranNodes.push(node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }));

    const foreignNodes = [
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, 'tls'),
      node('tls', 'TlsServer', {
        'cert-file': options.certPath,
        'key-file': options.keyPath,
        sni: options.sni,
        'select-alpns': csv(options.selectAlpns).length ? csv(options.selectAlpns) : ['h2', 'http/1.1'],
        'min-version': options.tlsMinVersion,
        'max-version': options.tlsMaxVersion,
        'session-cache': options.sessionCache,
      }, 'auth'),
      node('auth', 'VlessServer', {
        uuid: csv(options.uuid).join(','),
        connect: options.connectCmd !== false,
        udp: options.udpCmd !== false,
      }, 'out'),
      destConnector(),
    ];

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/vless-tls.json': j(chainConfig('vless-tls-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/vless-tls.json': j(chainConfig('vless-tls-foreign', foreignNodes)) } },
      client: {
        links: [
          options.entryMode === 'socks5'
            ? { label: 'SOCKS5 (روی سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}`, hint: 'نرم‌افزارهای خود را روی این SOCKS5 تنظیم کنید' }
            : null,
          {
            label: 'VLESS / TLS (اتصال مستقیم به خارج)',
            url: link({
              protocol: 'vless',
              host: options.foreignHost,
              port: options.publicPort,
              params: { type: 'tcp', security: 'tls', sni: options.sni, alpn: csv(options.alpns).join(','), fp: 'chrome', encryption: 'none' },
              fragment: `ww-${tunnel.name}`,
            }),
            hint: 'نیازمند گواهی معتبر برای SNI واردشده.',
          },
        ].filter(Boolean),
        instructions: [
          'حالت پیشنهادی: نرم‌افزار خود را روی SOCKS5 سرور ایران تنظیم کنید (رمزنگاری بین دو سرور انجام می‌شود).',
          'حالت دوم: اتصال مستقیم کلاینت به لینک VLESS/TLS روی سرور خارج.',
        ],
      },
      notes: [
        `Entry: ${options.entryMode === 'socks5' ? 'SOCKS5' : 'raw TCP'} on ${options.listenAddress}:${options.listenPort}`,
        `Foreign listener: 0.0.0.0:${options.publicPort}`,
      ],
      warnings: [
        `A TLS certificate must already exist on the foreign server at ${options.certPath} / ${options.keyPath}.`,
        'Make sure the certificate covers the SNI you set, otherwise the TlsClient handshake fails.',
      ],
    };
  },
};

// -------------------------------------------------------------------------
const vlessMuxTls = {
  id: 'vless-mux-tls',
  title: 'VLESS + Mux + TLS',
  titleFa: 'VLESS + Mux + TLS',
  category: 'stream',
  categoryFa: 'پروتکل',
  icon: '🧬',
  sides: ['iran', 'foreign'],
  summary: 'Adds MuxClient / MuxServer so many logical streams share few TCP connections — the canonical WaterWall chain.',
  summaryFa: 'با Mux چند اتصال منطقی روی چند اتصال TCP به‌اشتراک گذاشته می‌شود؛ مناسب برای وب‌گردی و کاهش سیستم‌کال.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/MuxClient',
  tags: ['vless', 'tls', 'mux'],
  fields: [
    ...ENTRY_FIELDS,
    ...vlessFields(),
    ...muxFields(),
    ...tlsFields(),
    ...coreFields(),
  ],
  build(ctx) {
    const { options, tunnel } = ctx;
    const muxSettings = { mode: options.muxMode };
    if (options.muxMode === 'timer') muxSettings['connection-duration-ms'] = Number(options.muxConnectionDurationMs) || 30000;
    if (options.muxMode === 'counter') muxSettings['connection-capacity'] = Number(options.muxConnectionCapacity) || 128;
    if (options.muxMode === 'fixed-connections-count') {
      muxSettings['per-worker-connections-count'] = Number(options.muxPerWorkerConnections) || 2;
    }
    if (options.muxMaxChildren) muxSettings['max-children'] = Number(options.muxMaxChildren);

    const iranNodes = [entryListener(options)];
    const socks = entrySocks(options, 'mux');
    if (socks) iranNodes.push(socks);
    iranNodes.push(node('mux', 'MuxClient', muxSettings, 'crypt'));
    iranNodes.push(
      node('crypt', 'VlessClient', {
        uuid: csv(options.uuid).join(','),
        'target-address': 'dest_context->address',
        port: 'dest_context->port',
        protocol: 'dest_context->protocol',
        'domain-strategy': options.vlessDomainStrategy || 'do-not-resolve-domains',
      }, 'tls'),
    );
    iranNodes.push(
      node('tls', 'TlsClient', { sni: options.sni, verify: options.verify !== false, alpns: csv(options.alpns) }, 'out'),
    );
    iranNodes.push(node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }));

    const foreignNodes = [
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true, 'large-send-buffer': true, 'large-recv-buffer': true }, 'tls'),
      node('tls', 'TlsServer', {
        'cert-file': options.certPath,
        'key-file': options.keyPath,
        sni: options.sni,
        'select-alpns': csv(options.selectAlpns).length ? csv(options.selectAlpns) : ['http/1.1'],
        'min-version': options.tlsMinVersion,
        'max-version': options.tlsMaxVersion,
      }, 'mux'),
      node('mux', 'MuxServer', { 'max-children': Number(options.muxMaxChildren) || 10000 }, 'auth'),
      node('auth', 'VlessServer', {
        uuid: csv(options.uuid).join(','),
        connect: options.connectCmd !== false,
        udp: options.udpCmd !== false,
      }, 'out'),
      destConnector(),
    ];

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/vless-mux.json': j(chainConfig('vless-mux-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/vless-mux.json': j(chainConfig('vless-mux-foreign', foreignNodes)) } },
      client: {
        links: options.entryMode === 'socks5'
          ? [{ label: 'SOCKS5 (روی سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}` }]
          : [{ label: 'VLESS/TLS', url: link({ protocol: 'vless', host: options.foreignHost, port: options.publicPort, params: { type: 'tcp', security: 'tls', sni: options.sni, encryption: 'none' }, fragment: `ww-${tunnel.name}` }) }],
        instructions: ['Mux یک ویژگی سمت سرور است؛ کلاینت شما فقط SOCKS5 یا VLESS ساده می‌بیند.'],
      },
      notes: [`Mux mode: ${options.muxMode}`, 'Server mirrors the order: TlsServer -> MuxServer -> VlessServer.'],
      warnings: ['Mux increases per-connection memory. Keep "client" ram-profile on the Iran side when traffic is high.'],
    };
  },
};

// -------------------------------------------------------------------------
const vlessReality = {
  id: 'vless-reality',
  title: 'VLESS over Reality',
  titleFa: 'VLESS روی Reality',
  category: 'stream',
  categoryFa: 'پروتکل',
  icon: '👻',
  sides: ['iran', 'foreign'],
  summary: 'RealityClient / RealityServer with a camouflage branch. No certificate needed — ordinary visitors are forwarded to a real website.',
  summaryFa: 'Reality بدون نیاز به گواهی SSL؛ بازدیدکننده‌های عادی به یک سایت واقعی هدایت می‌شوند و کلاینت‌های احرازشده وارد تونل می‌شوند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/RealityClient',
  tags: ['vless', 'reality', 'stealth', 'socks5'],
  fields: [
    ...ENTRY_FIELDS,
    ...vlessFields(),
    ...realityFields(),
    { key: 'muxEnabled', group: 'reality', label: 'Enable Mux', labelFa: 'فعال بودن Mux', type: 'boolean', default: true },
    ...muxFields(),
    ...coreFields(),
  ],
  build(ctx) {
    const { options, tunnel } = ctx;
    const realityCrypto = {
      password: options.realityPassword,
      salt: options.realitySalt,
      algorithm: options.realityAlgorithm,
      'kdf-iterations': Number(options.realityKdf) || 12000,
    };

    const iranNodes = [entryListener(options)];
    const socks = entrySocks(options, options.muxEnabled ? 'mux' : 'crypt');
    if (socks) iranNodes.push(socks);
    if (options.muxEnabled) {
      const muxSettings = { mode: options.muxMode };
      if (options.muxMode === 'timer') muxSettings['connection-duration-ms'] = Number(options.muxConnectionDurationMs) || 30000;
      if (options.muxMode === 'counter') muxSettings['connection-capacity'] = Number(options.muxConnectionCapacity) || 128;
      if (options.muxMode === 'fixed-connections-count') muxSettings['per-worker-connections-count'] = Number(options.muxPerWorkerConnections) || 2;
      iranNodes.push(node('mux', 'MuxClient', muxSettings, 'crypt'));
    }
    iranNodes.push(
      node('crypt', 'VlessClient', {
        uuid: csv(options.uuid).join(','),
        'target-address': 'dest_context->address',
        port: 'dest_context->port',
        protocol: 'dest_context->protocol',
        'domain-strategy': options.vlessDomainStrategy || 'do-not-resolve-domains',
      }, 'reality'),
    );
    iranNodes.push(node('reality', 'RealityClient', { sni: options.realitySni, ...realityCrypto, verify: true }, 'out'));
    iranNodes.push(node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }));

    const foreignNodes = [
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true, 'large-send-buffer': true, 'large-recv-buffer': true }, 'reality'),
      node(
        'reality',
        'RealityServer',
        {
          destination: 'visitor',
          'sniffing-attempts': Number(options.sniffingAttempts) || 8,
          ...realityCrypto,
        },
        'auth',
      ),
      node('auth', 'VlessServer', { uuid: csv(options.uuid).join(','), connect: options.connectCmd !== false, udp: options.udpCmd !== false }, 'out'),
      destConnector(),
      // Camouflage branch: ordinary visitors leave here.
      node('visitor', 'TcpConnector', { address: options.camouflageHost, port: Number(options.camouflagePort), nodelay: true }),
    ];

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/vless-reality.json': j(chainConfig('vless-reality-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/vless-reality.json': j(chainConfig('vless-reality-foreign', foreignNodes)) } },
      client: {
        links: [
          options.entryMode === 'socks5'
            ? { label: 'SOCKS5 (روی سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}` }
            : null,
          {
            label: 'VLESS / Reality (اتصال مستقیم به خارج)',
            url: link({
              protocol: 'vless',
              host: options.foreignHost,
              port: options.publicPort,
              params: {
                type: 'tcp',
                security: 'reality',
                sni: options.realitySni,
                pwd: options.realityPassword,
                fp: 'chrome',
                encryption: 'none',
              },
              fragment: `ww-${tunnel.name}`,
            }),
            hint: 'پارامتر pwd همان Reality password است که در پنل ساخته شده است.',
          },
        ].filter(Boolean),
        instructions: [
          'Reality هیچ گواهی نمی‌خواهد؛ فقط SNI و رمز مشترک لازم است.',
          'بازدیدکننده‌های غیرمجاز روی همان پورت به سایت استتار می‌روند.',
        ],
      },
      warnings: [
        `The camouflage destination must be a real HTTPS site that answers on ${options.camouflageHost}:${options.camouflagePort}.`,
        'WaterWall Reality authenticates with a shared password, not a public/private key pair.',
      ],
    };
  },
};

// -------------------------------------------------------------------------
const trojanTls = {
  id: 'trojan-tls',
  title: 'Trojan over TLS',
  titleFa: 'تراجان روی TLS',
  category: 'stream',
  categoryFa: 'پروتکل',
  icon: '🐴',
  sides: ['iran', 'foreign'],
  summary: 'Socks5Server -> TrojanClient -> TlsClient / TlsServer -> TrojanServer -> TcpConnector. Looks like ordinary TLS to a website.',
  summaryFa: 'پروتکل تراجان داخل TLS؛ برای ناظر شبکه دقیقاً شبیه یک اتصال HTTPS عادی به نظر می‌رسد.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/TrojanClient',
  tags: ['trojan', 'tls', 'socks5'],
  fields: [
    ...ENTRY_FIELDS,
    ...trojanFields(),
    ...tlsFields(),
    ...coreFields(),
  ],
  build(ctx) {
    const { options, tunnel } = ctx;
    const iranNodes = [entryListener(options)];
    const socks = entrySocks(options, 'crypt');
    if (socks) iranNodes.push(socks);
    iranNodes.push(
      node('crypt', 'TrojanClient', {
        password: options.trojanPassword,
        'target-address': 'dest_context->address',
        port: 'dest_context->port',
        protocol: 'dest_context->protocol',
        'domain-strategy': 'do-not-resolve-domains',
      }, 'tls'),
    );
    iranNodes.push(node('tls', 'TlsClient', { sni: options.sni, verify: options.verify !== false, alpns: csv(options.alpns) }, 'out'));
    iranNodes.push(node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }));

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
      node('auth', 'TrojanServer', { password: options.trojanPassword, connect: options.trojanConnect !== false, udp: options.trojanUdp !== false }, 'out'),
      destConnector(),
    ];

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/trojan-tls.json': j(chainConfig('trojan-tls-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/trojan-tls.json': j(chainConfig('trojan-tls-foreign', foreignNodes)) } },
      client: {
        links: [
          options.entryMode === 'socks5' ? { label: 'SOCKS5 (روی سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}` } : null,
          {
            label: 'Trojan / TLS',
            url: link({
              protocol: 'trojan',
              host: options.foreignHost,
              port: options.publicPort,
              params: { type: 'tcp', security: 'tls', sni: options.sni, alpn: csv(options.alpns).join(','), fp: 'chrome' },
              fragment: `ww-${tunnel.name}`,
            }),
            hint: 'رمز تراجان همان مقداری است که در پنل تولید شده.',
          },
        ].filter(Boolean),
      },
      warnings: [`Certificate required on the foreign server: ${options.certPath}`],
    };
  },
};

// -------------------------------------------------------------------------
const httpWsTls = {
  id: 'vless-http-ws-tls',
  title: 'VLESS over WebSocket + TLS',
  titleFa: 'VLESS روی WebSocket و TLS',
  category: 'stream',
  categoryFa: 'پروتکل',
  icon: '🕸️',
  sides: ['iran', 'foreign'],
  summary: 'HttpClient(websocket) + TlsClient on the Iran side, TlsServer + HttpServer on the foreign side. CDN-friendly HTTP transport.',
  summaryFa: 'ترافیک به شکل WebSocket روی HTTPS؛ قابل استفاده پشت CDN و روی پورت ۴۴۳.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/HttpClient',
  tags: ['vless', 'websocket', 'tls', 'cdn'],
  fields: [
    ...ENTRY_FIELDS,
    ...vlessFields(),
    ...tlsFields(),
    { key: 'wsPath', group: 'http', label: 'WebSocket path', labelFa: 'مسیر WebSocket', type: 'text', default: '/ws', required: true, help: 'HttpClient.settings.path and HttpServer.settings.path must match exactly.' },
    { key: 'wsHost', group: 'http', label: 'WebSocket host header', labelFa: 'هدر Host', type: 'text', default: '', help: 'HttpClient.settings.host — usually your domain. Leave empty to use the server host.' },
    { key: 'wsOrigin', group: 'http', label: 'WebSocket origin', labelFa: 'Origin', type: 'text', default: '' },
    { key: 'wsSubprotocol', group: 'http', label: 'WebSocket subprotocol', labelFa: 'زیرپروتکل', type: 'text', default: '' },
    { key: 'httpVersion', group: 'http', label: 'HTTP version', labelFa: 'نسخه HTTP', type: 'select', default: '1.1', options: ['1.1', '2', 'both', 'auto'] },
    ...coreFields(),
  ],
  build(ctx) {
    const { options, tunnel } = ctx;
    const host = options.wsHost || options.sni;
    const httpClient = {
      host,
      path: options.wsPath,
      'http-version': options.httpVersion,
      scheme: 'https',
      port: Number(options.publicPort),
      method: 'GET',
      websocket: true,
    };
    if (options.wsOrigin) httpClient['websocket-origin'] = options.wsOrigin;
    if (options.wsSubprotocol) httpClient['websocket-subprotocol'] = options.wsSubprotocol;

    const httpServer = {
      'http-version': options.httpVersion,
      path: options.wsPath,
      method: 'GET',
      status: 200,
      websocket: true,
      'websocket-origin': options.wsOrigin || 'https://example.com',
      'websocket-subprotocol': options.wsSubprotocol || 'ww-ws',
    };

    const iranNodes = [entryListener(options)];
    const socks = entrySocks(options, 'crypt');
    if (socks) iranNodes.push(socks);
    iranNodes.push(
      node('crypt', 'VlessClient', {
        uuid: csv(options.uuid).join(','),
        'target-address': 'dest_context->address',
        port: 'dest_context->port',
        protocol: 'dest_context->protocol',
      }, 'http'),
    );
    iranNodes.push(node('http', 'HttpClient', httpClient, 'tls'));
    iranNodes.push(node('tls', 'TlsClient', { sni: options.sni, verify: options.verify !== false, alpns: ['http/1.1'] }, 'out'));
    iranNodes.push(node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }));

    const foreignNodes = [
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, 'tls'),
      node('tls', 'TlsServer', {
        'cert-file': options.certPath,
        'key-file': options.keyPath,
        sni: options.sni,
        'select-alpns': ['http/1.1'],
        'min-version': options.tlsMinVersion,
        'max-version': options.tlsMaxVersion,
      }, 'http'),
      node('http', 'HttpServer', httpServer, 'auth'),
      node('auth', 'VlessServer', { uuid: csv(options.uuid).join(','), connect: true, udp: true }, 'out'),
      destConnector(),
    ];

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/vless-ws.json': j(chainConfig('vless-ws-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/vless-ws.json': j(chainConfig('vless-ws-foreign', foreignNodes)) } },
      client: {
        links: [
          options.entryMode === 'socks5' ? { label: 'SOCKS5 (روی سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}` } : null,
          {
            label: 'VLESS / WebSocket + TLS',
            url: link({
              protocol: 'vless',
              host: options.foreignHost,
              port: options.publicPort,
              params: { type: 'ws', security: 'tls', path: options.wsPath, host, sni: options.sni, encryption: 'none' },
              fragment: `ww-${tunnel.name}`,
            }),
            hint: 'مسیر WebSocket باید روی هر دو سرور یکسان باشد.',
          },
        ].filter(Boolean),
      },
      warnings: [
        'The path on HttpClient and HttpServer must be byte-identical.',
        'To place this behind a CDN, terminate TLS on the CDN and forward to the foreign port over plain HTTP — in that case drop TlsClient/TlsServer from the chain.',
      ],
    };
  },
};

// -------------------------------------------------------------------------
const udpOverTcp = {
  id: 'udp-over-tcp',
  title: 'UDP over TLS (framed)',
  titleFa: 'UDP روی TLS',
  category: 'stream',
  categoryFa: 'پروتکل',
  icon: '📦',
  sides: ['iran', 'foreign'],
  summary: 'UdpListener -> UdpOverTcpClient -> TlsClient -> TcpConnector / TlsServer -> UdpOverTcpServer -> UdpConnector. Carries UDP over a TCP-only path.',
  summaryFa: 'بسته‌های UDP با هدر ۲ بایتی طول روی مسیر TCP/TLS منتقل می‌شوند؛ مناسب DNS و WireGuard روی مسیرهای بدون UDP.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/UdpOverTcpClient',
  tags: ['udp', 'tls', 'framing'],
  clientHint: 'Send UDP datagrams to the Iran-side port; they are framed, TLS-wrapped and relayed.',
  fields: [
    { key: 'listenAddress', group: 'entry', label: 'Iran listen address', labelFa: 'آدرس شنود ایران', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'entry', label: 'Iran listen port', labelFa: 'پورت شنود ایران', type: 'number', default: 5353, min: 1, max: 65535, required: true },
    { key: 'publicPort', group: 'entry', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    ...destFields({ destAddress: '1.1.1.1', destPort: 53 }),
    ...tlsFields(),
    ...coreFields(),
  ],
  build(ctx) {
    const { options, tunnel } = ctx;
    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: {
          'configs/udp-over-tcp.json': j(
            chainConfig('udp-over-tcp-iran', [
              node('entry', 'UdpListener', { address: options.listenAddress, port: Number(options.listenPort) }, 'framer'),
              node('framer', 'UdpOverTcpClient', {}, 'tls'),
              node('tls', 'TlsClient', { sni: options.sni, verify: options.verify !== false, alpns: csv(options.alpns) }, 'out'),
              node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }),
            ]),
          ),
        },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/udp-over-tcp.json': j(
            chainConfig('udp-over-tcp-foreign', [
              node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, 'tls'),
              node('tls', 'TlsServer', {
                'cert-file': options.certPath,
                'key-file': options.keyPath,
                sni: options.sni,
                'min-version': options.tlsMinVersion,
                'max-version': options.tlsMaxVersion,
              }, 'deframe'),
              node('deframe', 'UdpOverTcpServer', {}, 'out'),
              node('out', 'UdpConnector', { address: options.destAddress, port: Number(options.destPort) }),
            ]),
          ),
        },
      },
      notes: [
        'UdpOverTcpClient / UdpOverTcpServer take no settings; framing is automatic (2-byte big-endian length).',
        'Maximum payload per frame is 65505 bytes.',
      ],
      warnings: ['Certificate required on the foreign server.'],
    };
  },
};

module.exports = [vlessTls, vlessMuxTls, vlessReality, trojanTls, httpWsTls, udpOverTcp];
