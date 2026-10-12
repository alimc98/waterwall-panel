'use strict';

const { coreFields, coreOpts, tlsFields, vlessFields, node, chainConfig, csv, link } = require('./common');

/**
 * Operational scenarios: reverse tunnels, routing, user management over the
 * WaterWall auth API, rate limiting and built-in test/benchmark chains.
 */

const j = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

// -------------------------------------------------------------------------
const routerSplit = {
  id: 'router-split',
  title: 'Domain-based split routing',
  titleFa: 'مسیریابی بر اساس دامنه',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '🧭',
  sides: ['iran', 'foreign'],
  summary: 'VLESS+TLS entry with a SniffRouter on the exit: listed domains go to one destination, everything else to another, blocked domains hit a BlackHole.',
  summaryFa: 'روی سرور خارج یک SniffRouter قرار می‌گیرد: دامنه‌های فهرست‌شده به یک مقصد، بقیه به مقصد دیگر و دامنه‌های مسدودشده به BlackHole می‌روند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/SniffRouter',
  tags: ['routing', 'sniff', 'split', 'block'],
  fields: [
    { key: 'listenAddress', group: 'entry', label: 'Local listen address', labelFa: 'آدرس شنود محلی', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'entry', label: 'Local SOCKS5 port', labelFa: 'پورت SOCKS5 محلی', type: 'number', default: 1080, min: 1, max: 65535, required: true },
    { key: 'publicPort', group: 'entry', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    ...vlessFields(),
    ...tlsFields(),
    { key: 'defaultDest', group: 'routes', label: 'Default destination', labelFa: 'مقصد پیش‌فرض', type: 'text', default: 'dest_context->address', help: 'Usually leave as dest_context->address / dest_context->port so normal traffic passes through.' },
    { key: 'defaultDestPort', group: 'routes', label: 'Default destination port', labelFa: 'پورت پیش‌فرض', type: 'text', default: 'dest_context->port' },
    { key: 'specialDomains', group: 'routes', label: 'Special domains', labelFa: 'دامنه‌های ویژه', type: 'csv', default: ['*.ir', '*.irancoder.ir'], help: 'Comma separated. These are routed to a dedicated destination.' },
    { key: 'specialDest', group: 'routes', label: 'Special destination', labelFa: 'مقصد ویژه', type: 'text', default: '127.0.0.1', required: true },
    { key: 'specialDestPort', group: 'routes', label: 'Special destination port', labelFa: 'پورت مقصد ویژه', type: 'number', default: 8080, min: 1, max: 65535 },
    { key: 'blockedDomains', group: 'routes', label: 'Blocked domains', labelFa: 'دامنه‌های مسدود', type: 'csv', default: ['*.ads.example'], help: 'Comma separated. Sent to a BlackHole node.' },
    { key: 'blockMode', group: 'routes', label: 'Block mode', labelFa: 'حالت مسدودسازی', type: 'select', default: 'active', options: ['passive', 'active'] },
    { key: 'detection', group: 'routes', label: 'Detection method', labelFa: 'روش تشخیص', type: 'select', default: 'http1,tls', options: ['http1,tls', 'http1', 'tls'] },
    ...coreFields(),
  ],
  build({ options }) {
    const detection = csv(options.detection);
    const routes = [];
    if (csv(options.specialDomains).length) {
      routes.push({ domains: csv(options.specialDomains), detection, next: 'special' });
    }
    if (csv(options.blockedDomains).length) {
      routes.push({ domains: csv(options.blockedDomains), detection, next: 'block' });
    }

    const iranNodes = [
      node('local', 'TcpUdpListener', { address: options.listenAddress, port: Number(options.listenPort), nodelay: true, 'large-send-buffer': true, 'large-recv-buffer': true }, 'socks'),
      node('socks', 'Socks5Server', { 'no-auth': true, connect: true, udp: true, 'udp-ipv4': options.iranHost || '127.0.0.1' }, 'crypt'),
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
        'min-version': options.tlsMinVersion,
        'max-version': options.tlsMaxVersion,
      }, 'auth'),
      node('auth', 'VlessServer', { uuid: csv(options.uuid).join(','), connect: true, udp: true }, 'router'),
      node('router', 'SniffRouter', { routes }, 'out'),
      node('out', 'TcpConnector', { address: options.defaultDest, port: options.defaultDestPort, nodelay: true }),
      node('special', 'TcpConnector', { address: options.specialDest, port: Number(options.specialDestPort) || 8080, nodelay: true }),
      node('block', 'BlackHole', { mode: options.blockMode || 'active' }),
    ];

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/router.json': j(chainConfig('router-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/router.json': j(chainConfig('router-foreign', foreignNodes)) } },
      client: { links: [{ label: 'SOCKS5 (روی سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}` }] },
      notes: [
        'SniffRouter: the first matching route wins; everything unmatched goes to the node named in its "next".',
        `Detection methods: ${detection.join(', ')} — TLS sniffing reads the SNI from the ClientHello.`,
      ],
      warnings: [
        'Sniffing only works for connections that actually start with HTTP/1.1 or a TLS ClientHello. ECH or non-standard clients may not be classified.',
        'For a domain-only router, leave "Default destination" as dest_context->address / dest_context->port.',
      ],
    };
  },
};

// -------------------------------------------------------------------------
const authUsers = {
  id: 'auth-users',
  title: 'User management over the WaterWall auth API',
  titleFa: 'مدیریت کاربران با API احراز هویت واتروال',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '👥',
  sides: ['iran', 'foreign'],
  summary: 'AuthenticationServer holds users.json, AuthenticationClient syncs it between the two servers, and Socks5Server/VlessServer authenticate against it. Add a user in the panel and it lands on both servers.',
  summaryFa: 'دیتابیس کاربران روی یک سرور نگه‌داری می‌شود و با AuthenticationClient بین دو سرور هم‌گام می‌شود. با افزودن کاربر در پنل، همان لحظه روی هر دو سرور اعمال می‌شود.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/AuthenticationServer',
  tags: ['auth', 'users', 'api', 'panel'],
  clientHint: 'Users authenticate with the username/password you create in the panel.',
  fields: [
    { key: 'authPort', group: 'auth', label: 'Auth control port', labelFa: 'پورت کنترل احراز هویت', type: 'number', default: 7788, min: 1, max: 65535, required: true, help: 'AuthenticationServer listener on the foreign side; AuthenticationClient dials this from Iran.' },
    { key: 'clientName', group: 'auth', label: 'Auth client name', labelFa: 'نام کلاینت احراز هویت', type: 'text', default: 'iran', required: true, help: 'AuthenticationClient.name must match an entry in AuthenticationServer.auth-clients.' },
    { key: 'authSecret', group: 'auth', label: 'Shared auth secret', labelFa: 'رمز مشترک', type: 'password', default: 'auto:password', required: true },
    { key: 'fileSaveRateMs', group: 'auth', label: 'DB save rate (ms)', labelFa: 'نرخ ذخیره دیتابیس', type: 'number', default: 60000, min: 1, required: true },
    { key: 'pingIntervalMs', group: 'auth', label: 'Ping interval (ms)', labelFa: 'فاصله ping', type: 'number', default: 60000, min: 0 },
    { key: 'pullIntervalMs', group: 'auth', label: 'Pull interval (ms)', labelFa: 'فاصله pull', type: 'number', default: 30000, min: 0, help: '0 disables pulling. Lower values make user changes appear faster.' },
    { key: 'pushIntervalMs', group: 'auth', label: 'Push interval (ms)', labelFa: 'فاصله push', type: 'number', default: 30000, min: 0, help: '0 disables pushing.' },
    { key: 'normalBackups', group: 'auth', label: 'DB backups', labelFa: 'پشتیبان‌گیری', type: 'select', default: 'disabled', options: ['disabled', 'hourly', 'daily', 'weekly'] },
    { key: 'listenAddress', group: 'entry', label: 'Local SOCKS5 address', labelFa: 'آدرس SOCKS5 محلی', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'entry', label: 'Local SOCKS5 port', labelFa: 'پورت SOCKS5 محلی', type: 'number', default: 1080, min: 1, max: 65535, required: true },
    { key: 'socksUdp', group: 'entry', label: 'Enable UDP', labelFa: 'UDP', type: 'boolean', default: true },
    { key: 'publicPort', group: 'entry', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    ...vlessFields(),
    ...tlsFields(),
    {
      key: 'users',
      group: 'users',
      label: 'Users',
      labelFa: 'کاربران',
      type: 'users',
      default: [],
      help: 'These become users.json for the AuthenticationServer. Add or remove rows here; the panel writes the file and both servers pick it up.',
    },
    ...coreFields(),
  ],
  build({ options }) {
    const users = (options.users || []).filter((u) => u && u.username);
    const clientEntry = {
      name: options.clientName,
      secret: options.authSecret,
      'allow-user-pull': true,
      'allow-user-write': true,
      'allow-stats-push': true,
    };
    const db = {
      users: users.map((u, i) => {
        const entry = {
          id: Number(u.id) || i + 1,
          name: u.username,
          username: u.username,
          password: u.password,
          enabled: u.enabled !== false,
        };
        const limit = {};
        if (u.deviceLimit) limit.devices = Number(u.deviceLimit);
        if (u.totalLimitGb) limit.traffic = { total: Math.round(Number(u.totalLimitGb) * 1024 * 1024 * 1024) };
        if (Object.keys(limit).length) entry.limit = limit;
        const time = {};
        if (u.expiresAt) time['expire-at-ms'] = new Date(u.expiresAt).getTime();
        if (Object.keys(time).length) entry.time = time;
        return entry;
      }),
    };

    const iranNodes = [
      node('authctl', 'AuthenticationClient', {
        name: options.clientName,
        secret: options.authSecret,
        'ping-interval-ms': Number(options.pingIntervalMs) || 0,
        'pull-interval-ms': Number(options.pullIntervalMs) || 0,
        'push-interval-ms': Number(options.pushIntervalMs) || 0,
      }, 'authctl-out'),
      node('authctl-out', 'TcpConnector', { address: options.foreignHost, port: Number(options.authPort), nodelay: true }),
      node('local', 'TcpUdpListener', { address: options.listenAddress, port: Number(options.listenPort), nodelay: true, 'large-send-buffer': true, 'large-recv-buffer': true }, 'socks'),
      node('socks', 'Socks5Server', {
        'auth-client-node-name': 'authctl',
        connect: true,
        udp: options.socksUdp !== false,
        ...(options.socksUdp !== false ? { 'udp-ipv4': options.iranHost || '127.0.0.1' } : {}),
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
      node('authd', 'TcpListener', { address: '0.0.0.0', port: Number(options.authPort), nodelay: true }, 'authsrv'),
      node('authsrv', 'AuthenticationServer', {
        'db-path': 'users.json',
        'file-save-rate-ms': Number(options.fileSaveRateMs) || 60000,
        'auth-clients': [clientEntry],
        'normal-backups': options.normalBackups || 'disabled',
        ...(options.normalBackups && options.normalBackups !== 'disabled'
          ? { 'normal-backups-path': 'backups' }
          : {}),
        'normal-backups-count-limit': 10,
      }),
      node('authctl', 'AuthenticationClient', {
        name: `${options.clientName}-exit`,
        secret: options.authSecret,
        'ping-interval-ms': Number(options.pingIntervalMs) || 0,
        'pull-interval-ms': Number(options.pullIntervalMs) || 0,
        'push-interval-ms': Number(options.pushIntervalMs) || 0,
      }, 'authctl-out'),
      node('authctl-out', 'TcpConnector', { address: options.iranHost, port: Number(options.authPort), nodelay: true }),
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, 'tls'),
      node('tls', 'TlsServer', {
        'cert-file': options.certPath,
        'key-file': options.keyPath,
        sni: options.sni,
        'min-version': options.tlsMinVersion,
        'max-version': options.tlsMaxVersion,
      }, 'auth'),
      node('auth', 'VlessServer', { 'auth-client-node-name': 'authctl', connect: true, udp: true }, 'out'),
      node('out', 'TcpConnector', { address: 'dest_context->address', port: 'dest_context->port', nodelay: true }),
    ];

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/auth.json': j(chainConfig('auth-iran', iranNodes)) } },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'users.json': `${JSON.stringify(db, null, 2)}\n`,
          'configs/auth.json': j(chainConfig('auth-foreign', foreignNodes)),
        },
      },
      client: {
        links: [{ label: 'SOCKS5 با نام کاربری (سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}` }],
        text: users.length
          ? users.map((u) => `# ${u.username}\nsocks5://${u.username}:${u.password}@${options.iranHost}:${options.listenPort}`).join('\n')
          : 'هنوز کاربری تعریف نشده است.',
        instructions: [
          'کاربر جدید را در همین صفحه اضافه کن و «ذخیره و اعمال» را بزن؛ فایل users.json بازنویسی و سرویس ری‌استارت می‌شود.',
          'AuthenticationServer روی سرور خارج دیتابیس را نگه می‌دارد و AuthenticationClient سمت ایران آن را pull می‌کند.',
        ],
      },
      notes: [
        `users.json currently holds ${users.length} user(s).`,
        'auth-clients entries are mirrored on both sides, so each server can serve the other.',
        'Restart the WaterWall service after a user change; the panel does this for you.',
      ],
      warnings: [
        'The auth control port must be reachable between the two servers. Restrict it with a firewall or tunnel it over the same WireGuard interface.',
        'Socks5Server.auth-client-node-name and "no-auth" are mutually exclusive.',
      ],
    };
  },
};

// -------------------------------------------------------------------------
const vlessHardened = {
  id: 'vless-hardened',
  title: 'Hardened VLESS (IP limit, rate limit, logging)',
  titleFa: 'VLESS سخت‌گیرانه (محدودیت IP، پهنای باند، لاگ)',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '🛡️',
  sides: ['iran', 'foreign'],
  summary: 'VLESS+TLS with SoftIpLimiter (connections per source IP), SpeedLimit (token bucket) and LoggerTunnel on the exit side.',
  summaryFa: 'زنجیره VLESS+TLS به‌همراه محدودکننده تعداد اتصال به ازای هر IP، محدودکننده سرعت و لاگ‌گیری ترافیک روی سرور خارج.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/SoftIpLimiter',
  tags: ['vless', 'tls', 'ratelimit', 'logging'],
  fields: [
    { key: 'listenAddress', group: 'entry', label: 'Local listen address', labelFa: 'آدرس شنود محلی', type: 'text', default: '0.0.0.0' },
    { key: 'listenPort', group: 'entry', label: 'Local SOCKS5 port', labelFa: 'پورت SOCKS5 محلی', type: 'number', default: 1080, min: 1, max: 65535, required: true },
    { key: 'publicPort', group: 'entry', label: 'Foreign public port', labelFa: 'پورت عمومی خارج', type: 'number', default: 443, min: 1, max: 65535, required: true },
    ...vlessFields(),
    ...tlsFields(),
    { key: 'ipLimitEnabled', group: 'limits', label: 'Limit connections per IP', labelFa: 'محدودیت اتصال به ازای IP', type: 'boolean', default: true },
    { key: 'simultaneousUserLimit', group: 'limits', label: 'Simultaneous users per IP', labelFa: 'کاربر همزمان', type: 'number', default: 2, min: 1, max: 6, when: { ipLimitEnabled: true } },
    { key: 'toleranceMs', group: 'limits', label: 'Tolerance (ms)', labelFa: 'مهلت', type: 'number', default: 60000, min: 1, when: { ipLimitEnabled: true } },
    { key: 'onIdentificationFailure', group: 'limits', label: 'On identification failure', labelFa: 'در صورت ناموفق', type: 'select', default: 'passthrough', options: ['passthrough', 'close'], when: { ipLimitEnabled: true } },
    { key: 'speedLimitEnabled', group: 'limits', label: 'Enable rate limit', labelFa: 'محدودیت سرعت', type: 'boolean', default: false },
    { key: 'megaBytesPerSec', group: 'limits', label: 'Speed limit (MB/s)', labelFa: 'سقف سرعت', type: 'number', default: 10, min: 0, when: { speedLimitEnabled: true } },
    { key: 'limitMode', group: 'limits', label: 'Limit mode', labelFa: 'حالت محدودیت', type: 'select', default: 'per-line', options: ['per-line', 'per-connection', 'all-lines', 'all-connections', 'per-worker'], when: { speedLimitEnabled: true } },
    { key: 'workMode', group: 'limits', label: 'Work mode', labelFa: 'حالت کار', type: 'select', default: 'pause', options: ['pause', 'drop'], when: { speedLimitEnabled: true } },
    { key: 'loggerEnabled', group: 'limits', label: 'Log traffic', labelFa: 'لاگ ترافیک', type: 'boolean', default: false },
    { key: 'loggerMode', group: 'limits', label: 'Logger mode', labelFa: 'حالت لاگ', type: 'select', default: 'log', options: ['log', 'file'], when: { loggerEnabled: true } },
    { key: 'loggerLevel', group: 'limits', label: 'Logger level', labelFa: 'سطح لاگ', type: 'select', default: 'info', options: ['debug', 'info', 'warning', 'error', 'fatal'], when: { loggerMode: 'log' } },
    ...coreFields(),
  ],
  build({ options }) {
    const iranNodes = [
      node('local', 'TcpUdpListener', { address: options.listenAddress, port: Number(options.listenPort), nodelay: true, 'large-send-buffer': true, 'large-recv-buffer': true }, 'socks'),
      node('socks', 'Socks5Server', { 'no-auth': true, connect: true, udp: true, 'udp-ipv4': options.iranHost || '127.0.0.1' }, 'crypt'),
      node('crypt', 'VlessClient', { uuid: csv(options.uuid).join(','), 'target-address': 'dest_context->address', port: 'dest_context->port', protocol: 'dest_context->protocol' }, 'tls'),
      node('tls', 'TlsClient', { sni: options.sni, verify: options.verify !== false, alpns: csv(options.alpns) }, 'out'),
      node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }),
    ];

    const foreignNodes = [
      node('public', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, 'tls'),
      node('tls', 'TlsServer', {
        'cert-file': options.certPath,
        'key-file': options.keyPath,
        sni: options.sni,
        'min-version': options.tlsMinVersion,
        'max-version': options.tlsMaxVersion,
      }, 'iplimit'),
    ];

    if (options.ipLimitEnabled) {
      foreignNodes.push(
        node('iplimit', 'SoftIpLimiter', {
          identifier: 'vless',
          'simultaneous-user-limit': Number(options.simultaneousUserLimit) || 2,
          'tolerance-ms': Number(options.toleranceMs) || 60000,
          'on-identification-failure': options.onIdentificationFailure || 'passthrough',
        }, 'auth'),
      );
    } else {
      foreignNodes.push(node('iplimit', 'LoggerTunnel', { mode: 'log', level: 'debug' }, 'auth'));
    }

    foreignNodes.push(
      node('auth', 'VlessServer', { uuid: csv(options.uuid).join(','), connect: true, udp: true }, options.speedLimitEnabled ? 'speedlimit' : 'out'),
    );

    if (options.speedLimitEnabled) {
      foreignNodes.push(
        node('speedlimit', 'SpeedLimit', {
          'mega-bytes-per-sec': Number(options.megaBytesPerSec) || 10,
          'limit-mode': options.limitMode || 'per-line',
          'work-mode': options.workMode || 'pause',
          'token-recharge-rate': 10,
        }, 'logger'),
      );
    }

    if (options.loggerEnabled && options.loggerMode === 'file') {
      foreignNodes.push(node('logger', 'LoggerTunnel', { mode: 'file', 'output-mode': 'split-direction' }, 'out'));
    } else {
      foreignNodes.push(node('logger', 'LoggerTunnel', { mode: options.loggerEnabled ? 'log' : 'log', level: options.loggerLevel || 'info' }, 'out'));
    }

    foreignNodes.push(node('out', 'TcpConnector', { address: 'dest_context->address', port: 'dest_context->port', nodelay: true }));

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/hardened.json': j(chainConfig('hardened-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/hardened.json': j(chainConfig('hardened-foreign', foreignNodes)) } },
      client: { links: [{ label: 'SOCKS5 (روی سرور ایران)', url: `socks5://${options.iranHost}:${options.listenPort}` }] },
      notes: [
        'SoftIpLimiter must sit after TLS termination and before VlessServer, which is exactly where this template puts it.',
        'The simulated-user-limit range WaterWall accepts is 1..6.',
      ],
      warnings: ['per-line rate limits let a single client open many lines and exceed the total cap; use all-lines for a hard global limit.'],
    };
  },
};

// -------------------------------------------------------------------------
const speedtest = {
  id: 'speedtest',
  title: 'Built-in speed test chain',
  titleFa: 'زنجیره تست سرعت داخلی واتروال',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '📊',
  sides: ['iran', 'foreign'],
  summary: 'SpeedTestClient on the Iran side against SpeedTestServer on the foreign side — measures the tunnel itself, not the public internet.',
  summaryFa: 'تست سرعت داخلی واتروال: سرعت واقعی تونل بین دو سرور را اندازه می‌گیرد، نه سرعت اینترنت. برای TCP و UDP.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/SpeedTestClient',
  tags: ['speedtest', 'benchmark', 'tcp', 'udp'],
  fields: [
    { key: 'mode', group: 'test', label: 'Mode', labelFa: 'حالت', type: 'select', default: 'tcp', options: ['tcp', 'udp'] },
    { key: 'direction', group: 'test', label: 'Direction', labelFa: 'جهت', type: 'select', default: 'bidirectional', options: ['upload', 'download', 'bidirectional'] },
    { key: 'durationMs', group: 'test', label: 'Duration (ms)', labelFa: 'مدت', type: 'number', default: 10000, min: 1 },
    { key: 'warmupMs', group: 'test', label: 'Warmup (ms)', labelFa: 'گرم‌کردن', type: 'number', default: 0, min: 0 },
    { key: 'connectionCount', group: 'test', label: 'Connections', labelFa: 'تعداد اتصال', type: 'number', default: 2, min: 1 },
    { key: 'targetMbps', group: 'test', label: 'Target speed (Mbit/s, 0 = unlimited)', labelFa: 'سرعت هدف', type: 'number', default: 0, min: 0 },
    { key: 'publicPort', group: 'test', label: 'Foreign test port', labelFa: 'پورت تست خارج', type: 'number', default: 9090, min: 1, max: 65535, required: true },
    { key: 'jsonSummary', group: 'test', label: 'JSON summary', labelFa: 'خلاصه JSON', type: 'boolean', default: true },
    ...coreFields(),
  ],
  build({ options }) {
    const isUdp = options.mode === 'udp';
    const clientSettings = {
      mode: isUdp ? 'udp' : 'tcp',
      direction: options.direction,
      'duration-ms': Number(options.durationMs) || 10000,
      'warmup-ms': Number(options.warmupMs) || 0,
      'connection-count': Number(options.connectionCount) || 1,
      'json-summary': options.jsonSummary !== false,
    };
    if (Number(options.targetMbps) > 0) clientSettings['target-megabits-per-sec'] = Number(options.targetMbps);

    const iranNodes = [
      node('entry', isUdp ? 'UdpListener' : 'TcpListener', { address: '0.0.0.0', port: isUdp ? 0 : 0 }, 'st'),
      node('st', 'SpeedTestClient', clientSettings, 'out'),
      node('out', isUdp ? 'UdpConnector' : 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort) }),
    ];
    if (isUdp) iranNodes[0].settings = { address: '0.0.0.0', port: 0 };

    const foreignNodes = [
      node('entry', isUdp ? 'UdpListener' : 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort) }, 'st'),
      node('st', 'SpeedTestServer', { 'report-interval-ms': 1000, 'json-summary': options.jsonSummary !== false, quiet: false }),
    ];

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/speedtest.json': j(chainConfig('speedtest-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/speedtest.json': j(chainConfig('speedtest-foreign', foreignNodes)) } },
      notes: [
        'The client listener uses port 0 so the OS picks a free port — the important number is the foreign test port.',
        'Read the result from log/network.log on the Iran server, or from the panel log viewer.',
      ],
      warnings: ['UDP speed tests need a real UDP path; if UDP is filtered use mode = tcp.'],
    };
  },
};

// -------------------------------------------------------------------------
const testerChain = {
  id: 'tester-chain',
  title: 'Chain validator (Tester)',
  titleFa: 'اعتبارسنج زنجیره (Tester)',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '🧪',
  sides: ['iran', 'foreign'],
  summary: 'TesterClient against TesterServer — deterministic synthetic traffic that proves a chain actually forwards payloads.',
  summaryFa: 'ترافیک مصنوعی قطعی: ثابت می‌کند که زنجیره واقعاً داده را عبور می‌دهد. برای عیب‌یابی قبل از اتصال کاربران عالی است.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/TesterClient',
  tags: ['test', 'validation', 'debug'],
  fields: [
    { key: 'publicPort', group: 'test', label: 'Foreign test port', labelFa: 'پورت تست خارج', type: 'number', default: 9091, min: 1, max: 65535, required: true },
    { key: 'chunkCount', group: 'test', label: 'Chunk count (1-11)', labelFa: 'تعداد chunk', type: 'number', default: 11, min: 1, max: 11 },
    { key: 'maxPayloadSize', group: 'test', label: 'Max payload size (0 = normal)', labelFa: 'حداکثر اندازه', type: 'number', default: 0, min: 0 },
    { key: 'splitPayloadDelayMs', group: 'test', label: 'Split delay (ms)', labelFa: 'تأخیر بخش‌بندی', type: 'number', default: 1, min: 0 },
    { key: 'streamingResponse', group: 'test', label: 'Streaming response', labelFa: 'پاسخ جریانی', type: 'boolean', default: false },
    { key: 'keepaliveEnabled', group: 'test', label: 'Add keepalive framing', labelFa: 'افزودن keepalive', type: 'boolean', default: true },
    { key: 'keepaliveIntervalMs', group: 'test', label: 'Keepalive interval (ms)', labelFa: 'فاصله keepalive', type: 'number', default: 30000, min: 1, when: { keepaliveEnabled: true } },
    { key: 'encryptionEnabled', group: 'test', label: 'Wrap in Encryption nodes', labelFa: 'پیچیدن در رمزنگاری', type: 'boolean', default: true },
    { key: 'encryptionPassword', group: 'test', label: 'Encryption password', labelFa: 'رمز', type: 'password', default: 'auto:password', when: { encryptionEnabled: true } },
    ...coreFields(),
  ],
  build({ options }) {
    const encryption = options.encryptionEnabled
      ? { password: options.encryptionPassword, algorithm: 'chacha20-poly1305', salt: 'ww-tester', 'kdf-iterations': 12000 }
      : null;

    const clientSettings = {
      'chunk-count': Number(options.chunkCount) || 11,
      'max-payload-size': Number(options.maxPayloadSize) || 0,
      'split-payload-delay-ms': Number(options.splitPayloadDelayMs) ?? 1,
      transport: 'none',
    };
    const serverSettings = {
      'chunk-count': Number(options.chunkCount) || 11,
      'max-payload-size': Number(options.maxPayloadSize) || 0,
      'split-payload-delay-ms': Number(options.splitPayloadDelayMs) ?? 1,
      'streaming-response': options.streamingResponse !== false,
      transport: 'none',
    };

    const iranNodes = [node('tc', 'TesterClient', clientSettings, 'ka')];
    if (encryption) iranNodes.push(node('ka', 'KeepAliveClient', { 'ping-interval': Number(options.keepaliveIntervalMs) || 30000 }, 'crypt'));
    else iranNodes[0].next = 'out';
    if (encryption) iranNodes.push(node('crypt', 'EncryptionClient', encryption, 'out'));
    iranNodes.push(node('out', 'TcpConnector', { address: options.foreignHost, port: Number(options.publicPort), nodelay: true }));

    const foreignNodes = [node('entry', 'TcpListener', { address: '0.0.0.0', port: Number(options.publicPort), nodelay: true }, encryption ? 'ka' : 'ts')];
    if (encryption) {
      foreignNodes.push(node('ka', 'KeepAliveServer', {}, 'decrypt'));
      foreignNodes.push(node('decrypt', 'EncryptionServer', encryption, 'ts'));
    }
    foreignNodes.push(node('ts', 'TesterServer', serverSettings));

    return {
      iran: { core: coreOpts(options, { ramProfile: 'client' }), files: { 'configs/tester.json': j(chainConfig('tester-iran', iranNodes)) } },
      foreign: { core: coreOpts(options, { ramProfile: 'server' }), files: { 'configs/tester.json': j(chainConfig('tester-foreign', foreignNodes)) } },
      notes: [
        'TesterServer answers with the same chunk layout it expects, so a pass means the framing survived the whole path.',
        'Check log/network.log on the Iran server for the tester result.',
      ],
      warnings: ['This chain is self-contained: it tests the tunnel, not the public internet.'],
    };
  },
};

module.exports = [routerSplit, authUsers, vlessHardened, speedtest, testerChain];
