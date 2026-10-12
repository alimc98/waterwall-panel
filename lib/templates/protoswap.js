'use strict';

const { coreFields, coreOpts, node, csv } = require('./common');
const { emitConfig } = require('../generator');

/**
 * Protocol-number swapping.
 *
 * Instead of rewriting TCP flag bits, this replaces the IPv4 Protocol field
 * itself, so the traffic stops looking like TCP (6) or UDP (17) on the wire.
 *
 *   Iran     users_inbound -> tcp-out -> TUN -> IpOverrider
 *                                            -> IpManipulator(protoswap) -> ObfuscatorClient -> RawSocket
 *   Foreign  TUN -> IpOverrider -> IpManipulator(protoswap) -> ObfuscatorServer -> RawSocket
 *
 * Both ends must use the same replacement number: IpManipulator detects its own
 * replacement on the way back and restores the real protocol. The TCP/UDP
 * pseudo-header checksums are handled by the node, so no manual work is needed.
 *
 * WaterWall rejects a replacement of 6 or 17 (the real TCP/UDP numbers) and, if
 * both families are enabled, requires the two numbers to differ. The panel
 * checks this before generating anything, because WaterWall would only fail at
 * startup otherwise.
 */

const emit = (config, options) => emitConfig(config, { useVariables: options.useVariables !== false });

function withVarSentinels(nodes, rules) {
  return nodes.map((n) => {
    const copy = JSON.parse(JSON.stringify(n));
    const fn = rules[copy.name];
    if (fn) fn(copy);
    return copy;
  });
}

const obfClient = (key, skip) => ({ method: 'xor', xor_key: Number(key) || 0, skip });
const obfServer = (key, skip) => ({ method: 'xor', xor_key: Number(key) || 0, skip });

/** Protocol numbers WaterWall refuses as a replacement. */
const RESERVED = [6, 17];

function userTlsNode(next) {
  return node(
    'tls_user_side',
    'TlsServer',
    {
      'cert-file': '/root/fullchain.pem',
      'key-file': '/root/privkey.pem',
      'min-version': 'TLSv1.2',
      'max-version': 'TLSv1.3',
      ciphers: 'HIGH:!aNULL:!MD5',
      'session-cache': 'none',
      'session-tickets': true,
    },
    next,
  );
}

/** Build the `protoswap-*` settings and validate them the way WaterWall does. */
function protoswapSettings(options) {
  const mode = options.swapMode || 'tcp';
  const settings = {};
  const problems = [];

  if (mode === 'tcp' || mode === 'both') {
    const n = Number(options.protoswapTcp);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      problems.push(`شماره پروتکل TCP باید یک عدد صحیح بین ۰ تا ۲۵۵ باشد (مقدار فعلی: ${options.protoswapTcp})`);
    } else {
      if (RESERVED.includes(n)) problems.push(`شماره ${n} رزرو شده است؛ واتروال اجازه تعویض TCP (6) یا UDP (17) را نمی‌دهد چون ترافیک واقعی روی همان عدد قابل تفکیک نیست.`);
      settings['protoswap-tcp'] = n;
    }
  }

  if (mode === 'udp' || mode === 'both') {
    const n = Number(options.protoswapUdp);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      problems.push(`شماره پروتکل UDP باید یک عدد صحیح بین ۰ تا ۲۵۵ باشد (مقدار فعلی: ${options.protoswapUdp})`);
    } else {
      if (RESERVED.includes(n)) problems.push(`شماره ${n} رزرو شده است؛ واتروال اجازه تعویض TCP (6) یا UDP (17) را نمی‌دهد.`);
      settings['protoswap-udp'] = n;
    }
  }

  if (settings['protoswap-tcp'] !== undefined && settings['protoswap-udp'] !== undefined) {
    if (settings['protoswap-tcp'] === settings['protoswap-udp']) {
      problems.push('شماره TCP و UDP باید متفاوت باشند، وگرنه واترول هنگام اجرا خطا می‌دهد.');
    }
  }

  if (problems.length) throw new Error(problems.join(' '));
  if (!Object.keys(settings).length) throw new Error('حداقل یکی از تعویض TCP یا UDP باید فعال باشد.');
  return settings;
}

const protoswap = {
  id: 'protoswap',
  title: 'Protocol Number Swapping',
  titleFa: 'تعویض شماره پروتکل (TCP و UDP)',
  category: 'stealth',
  categoryFa: 'استتار',
  icon: '🔢',
  sides: ['iran', 'foreign'],
  summary:
    'TunDevice -> IpOverrider -> IpManipulator(protoswap) -> Obfuscator -> RawSocket. The IPv4 Protocol field is rewritten so the traffic no longer appears as TCP or UDP.',
  summaryFa:
    'به‌جای دستکاری بیت‌های TCP، خود شماره پروتکل در هدر IPv4 عوض می‌شود. ترافیک دیگر روی سیم TCP (۶) یا UDP (۱۷) به نظر نمی‌رسد و به یک شماره دلخواه تبدیل می‌شود. چک‌سام TCP/UDP خودکار توسط نود مدیریت می‌شود.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/IpManipulator',
  tags: ['stealth', 'packets', 'raw-socket', 'protoswap', 'tcp', 'udp'],
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی روی TUN دوم سرور خارج تحویل می‌گیرد.',
  fields: [
    {
      key: 'swapMode',
      group: 'protoswap',
      label: 'Which protocols to swap',
      labelFa: 'کدام پروتکل‌ها تعویض شود',
      type: 'select',
      default: 'tcp',
      options: ['tcp', 'udp', 'both'],
      help: 'حالت both نیازمند دو شماره متفاوت است.',
    },
    {
      key: 'protoswapTcp',
      group: 'protoswap',
      label: 'TCP replacement number',
      labelFa: 'شماره جایگزین TCP',
      type: 'number',
      default: 50,
      min: 0,
      max: 255,
      required: true,
      when: { swapMode: ['tcp', 'both'] },
      help: 'مقدار ۶ یا ۱۷ مجاز نیست. پیش‌فرض ۵۰ از محدوده‌های کم‌کاربرد IPv4 است.',
    },
    {
      key: 'protoswapUdp',
      group: 'protoswap',
      label: 'UDP replacement number',
      labelFa: 'شماره جایگزین UDP',
      type: 'number',
      default: 51,
      min: 0,
      max: 255,
      required: true,
      when: { swapMode: ['udp', 'both'] },
      help: 'مقدار ۶ یا ۱۷ مجاز نیست و باید با شماره TCP فرق داشته باشد.',
    },
    {
      key: 'listenPort',
      group: 'entry',
      label: 'User-facing port (Iran)',
      labelFa: 'پورت کاربران (ایران)',
      type: 'number',
      default: 443,
      min: 1,
      max: 65535,
      required: true,
      help: 'در حالت udp یا both این پورت برای TCP و UDP با هم استفاده می‌شود.',
    },
    { key: 'listenAddress', group: 'entry', label: 'Bind address (Iran)', labelFa: 'آدرس bind (ایران)', type: 'text', default: '0.0.0.0' },
    {
      key: 'userTlsTermination',
      group: 'entry',
      label: 'Terminate TLS for users',
      labelFa: 'خاتمه TLS برای کاربران',
      type: 'boolean',
      default: false,
      help: 'اگر روشن باشد یک TlsServer بین users_inbound و tcp-out قرار می‌گیرد. برای خود مسیر بین دو سرور لازم نیست.',
    },
    {
      key: 'iranTunName',
      group: 'tun',
      label: 'Shared TUN name',
      labelFa: 'نام TUN مشترک',
      type: 'text',
      default: 'wtun1',
      required: true,
    },
    {
      key: 'iranTunIp',
      group: 'tun',
      label: 'Shared TUN IPv4',
      labelFa: 'آدرس TUN مشترک',
      type: 'text',
      default: '10.10.0.1/24',
      required: true,
    },
    {
      key: 'iranPeerTunIp',
      group: 'tun',
      label: 'Peer TUN IPv4 (Iran side)',
      labelFa: 'آدرس TUN مقابل (ایران)',
      type: 'text',
      default: '10.10.0.2',
      required: true,
    },
    {
      key: 'foreignTunName',
      group: 'tun',
      label: 'TUN name (foreign)',
      labelFa: 'نام TUN (خارج)',
      type: 'text',
      default: 'wtun1',
    },
    {
      key: 'foreignTunIp',
      group: 'tun',
      label: 'TUN IPv4 (foreign)',
      labelFa: 'آدرس TUN (خارج)',
      type: 'text',
      default: '10.10.0.1/24',
    },
    {
      key: 'deviceMtu',
      group: 'tun',
      label: 'MTU',
      labelFa: 'MTU',
      type: 'number',
      default: 1400,
      min: 68,
      max: 65535,
    },
    {
      key: 'xorKey',
      group: 'obfuscation',
      label: 'XOR key (0-255)',
      labelFa: 'کلید XOR',
      type: 'number',
      default: 90,
      min: 0,
      max: 255,
      required: true,
    },
    {
      key: 'obfSkip',
      group: 'obfuscation',
      label: 'Skip mode',
      labelFa: 'حالت skip',
      type: 'select',
      default: 'transport',
      options: ['none', 'ipv4', 'transport'],
    },
    {
      key: 'probeProtocols',
      group: 'probe',
      label: 'Protocol numbers to test',
      labelFa: 'شماره‌هایی که تست شوند',
      type: 'csv',
      default: ['6', '50', '51', '132', '136', '255'],
      help: 'فهرست شماره‌هایی که دکمه «تست پروتکل» روی آن‌ها پکت می‌فرستد تا ببینید کدام روی مسیر شما باز است.',
    },
    {
      key: 'probeTimeoutMs',
      group: 'probe',
      label: 'Test timeout (ms)',
      labelFa: 'مهلت تست',
      type: 'number',
      default: 1500,
      min: 200,
      max: 10000,
    },
    {
      key: 'bypassConntrack',
      group: 'raw',
      label: 'Bypass conntrack',
      labelFa: 'دور زدن conntrack',
      type: 'boolean',
      default: true,
    },
    {
      key: 'useVariables',
      group: 'advanced',
      label: 'Use $variables$ in the config',
      labelFa: 'استفاده از متغیرها در کانفیگ',
      type: 'boolean',
      default: true,
    },
    ...coreFields().map((f) => (f.key === '_core.mtu' ? { ...f, default: 1400 } : f)),
  ],

  build({ options }) {
    const swap = protoswapSettings(options);
    const mode = options.swapMode || 'tcp';
    const useVars = options.useVariables !== false;
    const listenPort = Number(options.listenPort) || 443;
    const iranIp = options.iranHost;
    const foreignIp = options.foreignHost;
    const tunIpBase = String(options.iranTunIp).split('/')[0];
    const peerTunIp = options.iranPeerTunIp;
    const obf = obfClient(options.xorKey, options.obfSkip || 'transport');
    const bypass = { 'bypass-conntrack': options.bypassConntrack !== false };
    const withUdp = mode === 'udp' || mode === 'both';

    // ----------------------------------------------------------- Iran side
    const iranNodes = [
      node(
        'users_inbound',
        withUdp ? 'TcpUdpListener' : 'TcpListener',
        {
          address: options.listenAddress,
          port: listenPort,
          ...(withUdp ? { 'large-send-buffer': true, 'large-recv-buffer': true } : {}),
          nodelay: true,
        },
        options.userTlsTermination ? 'tls_user_side' : 'tcp-out',
      ),
    ];
    if (options.userTlsTermination) iranNodes.push(userTlsNode('tcp-out'));
    iranNodes.push(
      node('tcp-out', 'TcpConnector', { address: peerTunIp, port: listenPort, nodelay: true }),
      node('my tun', 'TunDevice', { 'device-name': options.iranTunName, 'device-ip': options.iranTunIp }, 'ipovsrc'),
      node(
        'ipovsrc',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: iranIp }, 'dest-ip': { ipv4: foreignIp } },
          down: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
        },
        'ip-manipulator',
      ),
      node('ip-manipulator', 'IpManipulator', { ...swap }, 'obfuscator-c'),
      node('obfuscator-c', 'ObfuscatorClient', obf, 'rd'),
      node('rd', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': foreignIp, ...bypass }),
    );

    const iranVariables = {
      ip_server_iran: iranIp,
      ip_server_kharej: foreignIp,
      port_listen_iran: listenPort,
      port_service_kharej: listenPort,
      tun_ip: tunIpBase,
      tun_peer_ip: peerTunIp,
      xor_key: Number(options.xorKey) || 0,
      obf_skip: options.obfSkip || 'transport',
      tun_name: options.iranTunName,
      tun_ip_cidr: options.iranTunIp,
      ...(swap['protoswap-tcp'] !== undefined ? { protoswap_tcp_to_number: swap['protoswap-tcp'] } : {}),
      ...(swap['protoswap-udp'] !== undefined ? { protoswap_udp_to_number: swap['protoswap-udp'] } : {}),
      ...(options.userTlsTermination ? { certificate_path: '/root/fullchain.pem', key_path: '/root/privkey.pem' } : {}),
    };

    const iranConfig = {
      name: 'iran-protoswap',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars ? { variables: iranVariables } : {}),
      nodes: withVarSentinels(iranNodes, {
        'my tun': (n) => {
          n.settings['device-name'] = '@tun_name';
          n.settings['device-ip'] = '@tun_ip_cidr';
        },
        ipovsrc: (n) => {
          n.settings.up['source-ip'].ipv4 = '@ip_server_iran';
          n.settings.up['dest-ip'].ipv4 = '@ip_server_kharej';
          n.settings.down['source-ip'].ipv4 = '@tun_peer_ip';
          n.settings.down['dest-ip'].ipv4 = '@tun_ip';
        },
        'tcp-out': (n) => {
          n.settings.address = '@tun_peer_ip';
          n.settings.port = '@port_service_kharej';
        },
        users_inbound: (n) => {
          n.settings.port = '@port_listen_iran';
        },
        'ip-manipulator': (n) => {
          if (n.settings['protoswap-tcp'] !== undefined) n.settings['protoswap-tcp'] = '@protoswap_tcp_to_number';
          if (n.settings['protoswap-udp'] !== undefined) n.settings['protoswap-udp'] = '@protoswap_udp_to_number';
        },
        'obfuscator-c': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        rd: (n) => {
          n.settings['capture-ip'] = '@ip_server_kharej';
        },
        tls_user_side: (n) => {
          n.settings['cert-file'] = '@certificate_path';
          n.settings['key-file'] = '@key_path';
        },
      }),
    };

    // -------------------------------------------------------- Foreign side
    const foreignNodes = [
      node('my tun2', 'TunDevice', { 'device-name': options.foreignTunName, 'device-ip': options.foreignTunIp }, 'ipcorrect'),
      node(
        'ipcorrect',
        'IpOverrider',
        {
          // On the return path the foreign box appears as the source.
          up: { 'source-ip': { ipv4: foreignIp }, 'dest-ip': { ipv4: iranIp } },
          down: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
        },
        'ip-manipulator',
      ),
      node('ip-manipulator', 'IpManipulator', { ...swap }, 'obfuscator-s'),
      node('obfuscator-s', 'ObfuscatorServer', obfServer(options.xorKey, options.obfSkip || 'transport'), 'rdin'),
      node('rdin', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': iranIp, ...bypass }),
    ];

    const foreignConfig = {
      name: 'foreign-protoswap',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              ip_server_iran: iranIp,
              ip_server_kharej: foreignIp,
              tun_ip: tunIpBase,
              tun_peer_ip: peerTunIp,
              xor_key: Number(options.xorKey) || 0,
              obf_skip: options.obfSkip || 'transport',
              tun_name: options.foreignTunName,
              tun_ip_cidr: options.foreignTunIp,
              ...(swap['protoswap-tcp'] !== undefined ? { protoswap_tcp_to_number: swap['protoswap-tcp'] } : {}),
              ...(swap['protoswap-udp'] !== undefined ? { protoswap_udp_to_number: swap['protoswap-udp'] } : {}),
            },
          }
        : {}),
      nodes: withVarSentinels(foreignNodes, {
        'my tun2': (n) => {
          n.settings['device-name'] = '@tun_name';
          n.settings['device-ip'] = '@tun_ip_cidr';
        },
        ipcorrect: (n) => {
          n.settings.up['source-ip'].ipv4 = '@ip_server_kharej';
          n.settings.up['dest-ip'].ipv4 = '@ip_server_iran';
          n.settings.down['source-ip'].ipv4 = '@tun_peer_ip';
          n.settings.down['dest-ip'].ipv4 = '@tun_ip';
        },
        'ip-manipulator': (n) => {
          if (n.settings['protoswap-tcp'] !== undefined) n.settings['protoswap-tcp'] = '@protoswap_tcp_to_number';
          if (n.settings['protoswap-udp'] !== undefined) n.settings['protoswap-udp'] = '@protoswap_udp_to_number';
        },
        'obfuscator-s': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        rdin: (n) => {
          n.settings['capture-ip'] = '@ip_server_iran';
        },
      }),
    };

    const swapList = [
      swap['protoswap-tcp'] !== undefined ? `TCP (6) → ${swap['protoswap-tcp']}` : null,
      swap['protoswap-udp'] !== undefined ? `UDP (17) → ${swap['protoswap-udp']}` : null,
    ].filter(Boolean);

    return {
      iran: { core: coreOpts(options, { mtu: Number(options.deviceMtu) || 1400, ramProfile: 'server' }), files: { 'configs/protoswap.json': emit(iranConfig, options) } },
      foreign: { core: coreOpts(options, { mtu: Number(options.deviceMtu) || 1400, ramProfile: 'server' }), files: { 'configs/protoswap.json': emit(foreignConfig, options) } },
      client: {
        links: [
          {
            label: 'نقطه ورود کاربران (ایران)',
            url: `${options.listenAddress === '0.0.0.0' ? iranIp : options.listenAddress}:${listenPort}`,
            hint: withUdp ? 'TCP و UDP هر دو روی این پورت کار می‌کنند.' : 'فقط TCP روی این پورت.',
          },
        ],
        instructions: [
          `کاربران به ${iranIp}:${listenPort} وصل می‌شوند. خروجی روی TUN دوم سرور خارج (${options.foreignTunName}) تحویل می‌گیرد.`,
          'روی سرور خارج باید یک سرویس روی TUN دوم گوش بدهد تا ترافیک کاربران را تحویل بگیرد.',
        ],
      },
      notes: [
        `تعویض فعال: ${swapList.join('، ')}.`,
        'هر دو سرور باید دقیقاً یک شماره داشته باشند؛ نود با دیدن شماره جایگزین خودش، پروتکل واقعی را برمی‌گرداند.',
        'چک‌سام TCP/UDP به‌صورت افزایشی اصلاح می‌شود و به‌ازای هر fragment هم اعمال می‌گردد، بنابراین نیازی به کار دستی با چک‌سام نیست.',
        withUdp
          ? 'چون UDP هم تعویض می‌شود، ورودی کاربران TcpUdpListener است تا هر دو پروتکل روی یک پورت کار کنند.'
          : 'فقط TCP تعویض می‌شود، پس ورودی کاربران TcpListener است.',
        'RawSocket روی سرور خارج پکت‌ها را با فیلتر source-ip می‌گیرد و باز می‌فرستد؛ نود IpManipulator شماره پروتکل را به حالت اصلی برمی‌گرداند.',
      ],
      warnings: [
        'شماره‌های ۶ و ۱۷ مجاز نیستند و اگر هر دو خانواده فعال باشند شماره‌ها باید متفاوت باشند — پنل این را قبل از تولید بررسی می‌کند چون واتروال فقط هنگام اجرا خطا می‌دهد.',
        'فقط دانستن اینکه یک شماره «مجاز» است کافی نیست؛ ممکن است روی مسیر شما فیلتر شود. از دکمه «تست پروتکل» استفاده کنید تا ببینید کدام شماره‌ها واقعاً عبور می‌کنند.',
        'RawSocket به root یا CAP_NET_ADMIN نیاز دارد: iptables و NFQUEUE را تنظیم می‌کند.',
        'پکت‌های capture‌شده از استک شبکه میزبان حذف می‌شوند؛ فیلترهای اشتباه می‌توانند ترافیک واقعی سرور را قطع کنند.',
        'این تکنیک بسیار وابسته به مسیر است؛ آنچه روی یک مسیر کار می‌کند ممکن است جای دیگر نادیده گرفته شود.',
      ],
      probe: {
        protocols: csv(options.probeProtocols).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 255),
        timeoutMs: Number(options.probeTimeoutMs) || 1500,
        fromServerId: 'iran',
        toServerId: 'foreign',
        targetField: 'foreignHost',
        excluded: [...new Set(RESERVED.filter((r) => swapList.some((s) => s.endsWith(` ${r}`))))],
      },
    };
  },
};

module.exports = [protoswap];
