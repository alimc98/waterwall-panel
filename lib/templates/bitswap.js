'use strict';

const { coreFields, coreOpts, node } = require('./common');
const { emitConfig } = require('../generator');

/**
 * TCP bit-swapping tunnels.
 *
 * The user's TCP stream is turned into real IPv4 packets, and the TCP control
 * bits are then rewritten so the traffic no longer looks like TCP on the wire.
 * An XOR obfuscator hides the rewritten flag byte from pattern matching, and
 * the paired TUN networks let the two boxes agree on who is who without ever
 * opening a TCP session of their own.
 *
 *   users -> MuxClient? -> TcpConnector(peer TUN)
 *         -> TunDevice -> IpOverrider -> PacketSplitStream
 *              ├── up   ── Obfuscator ── IpManipulator ── RawSocket
 *              └── down ── Obfuscator ── IpManipulator ── RawSocket
 *
 * Two variants exist:
 *   tcp-bit-swap        no Mux; the exit lands on a second TUN
 *   tcp-bit-swap-mux    MuxClient/MuxServer in front; the exit is a real
 *                       service (for example a local xray) on the foreign box
 *
 * RawSocket needs root or CAP_NET_ADMIN: it installs iptables rules and
 * captures with NFQUEUE, so the panel says so up front.
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

const userTlsNode = (next) =>
  node(
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

/** Bit-rewrite settings, optionally with packet duplication in front. */
function bitSettings(options, direction, a, b, duplicate) {
  const settings = { [`${direction}-tcp-bit-${a}`]: `packet->${b}` };
  if (Number(duplicate) > 0) settings['packet-duplicate'] = Number(duplicate);
  return settings;
}

/** Fields shared by all bit-swap variants. */
function sharedFields() {
  return [
    // ---- tunnel network ---------------------------------------------------
    {
      key: 'iranTunName',
      group: 'tun',
      label: 'Shared TUN name',
      labelFa: 'نام TUN مشترک',
      type: 'text',
      default: 'wtun1',
      required: true,
      help: 'هر دو سرور از همین نام استفاده می‌کنند؛ شبکه TUN بین آن‌ها مشترک است.',
    },
    {
      key: 'iranTunIp',
      group: 'tun',
      label: 'Shared TUN IPv4',
      labelFa: 'آدرس TUN مشترک',
      type: 'text',
      default: '10.10.0.1/24',
      required: true,
      help: 'IpOverrider آدرس‌های داخلی را با IP عمومی واقعی هر سرور جایگزین می‌کند، پس این آدرس‌ها روی سیم دیده نمی‌شوند.',
    },
    {
      key: 'iranPeerTunIp',
      group: 'tun',
      label: 'Peer TUN IPv4 (Iran side)',
      labelFa: 'آدرس TUN مقابل (ایران)',
      type: 'text',
      default: '10.10.0.2',
      required: true,
      help: 'مقصد tcp-out روی سرور ایران.',
    },
    {
      key: 'foreignTunName',
      group: 'tun',
      label: 'Second TUN name (foreign)',
      labelFa: 'نام TUN دوم (خارج)',
      type: 'text',
      default: 'wtun2',
      help: 'روی سرور خارج، TUN دوم خروجی کاربران را تحویل می‌گیرد.',
    },
    {
      key: 'foreignTunIp',
      group: 'tun',
      label: 'Second TUN IPv4 (foreign)',
      labelFa: 'آدرس TUN دوم (خارج)',
      type: 'text',
      default: '10.20.0.1/24',
      help: 'خروجی کاربران روی این اینترفیس تحویل داده می‌شود.',
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
      help: 'برای زنجیره‌های پکت محافظه‌کارانه بگذارید؛ فایل مرجع ۱۴۰۰ است.',
    },

    // ---- obfuscation ------------------------------------------------------
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
      help: 'ObfuscatorClient/Server.method = "xor". باید روی همه نودهای Obfuscator یکسان باشد.',
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

    // ---- bit swaps --------------------------------------------------------
    {
      key: 'iranUpSwapA',
      group: 'bitswap',
      label: 'Iran up: which bit is read',
      labelFa: 'ایران (بالا): کدام بیت خوانده شود',
      type: 'select',
      default: 'psh',
      options: ['cwr', 'ece', 'urg', 'ack', 'psh', 'rst', 'syn', 'fin'],
    },
    {
      key: 'iranUpSwapB',
      group: 'bitswap',
      label: 'Iran up: which bit is written',
      labelFa: 'ایران (بالا): کدام بیت نوشته شود',
      type: 'select',
      default: 'cwr',
      options: ['cwr', 'ece', 'urg', 'ack', 'psh', 'rst', 'syn', 'fin'],
      help: 'بیتی که خوانده می‌شود به این بیت روی سیم نوشته می‌شود. طرف مقابل باید برعکسش را بخواند.',
    },
    {
      key: 'iranDownSwapA',
      group: 'bitswap',
      label: 'Iran down: which bit is read',
      labelFa: 'ایران (پایین): کدام بیت خوانده شود',
      type: 'select',
      default: 'psh',
      options: ['cwr', 'ece', 'urg', 'ack', 'psh', 'rst', 'syn', 'fin'],
    },
    {
      key: 'iranDownSwapB',
      group: 'bitswap',
      label: 'Iran down: which bit is written',
      labelFa: 'ایران (پایین): کدام بیت نوشته شود',
      type: 'select',
      default: 'rst',
      options: ['cwr', 'ece', 'urg', 'ack', 'psh', 'rst', 'syn', 'fin'],
    },
    {
      key: 'foreignOutSwapA',
      group: 'bitswap',
      label: 'Foreign out: which bit is read',
      labelFa: 'خارج (خروجی): کدام بیت خوانده شود',
      type: 'select',
      default: 'psh',
      options: ['cwr', 'ece', 'urg', 'ack', 'psh', 'rst', 'syn', 'fin'],
      help: 'باید دقیقاً معکوس «ایران پایین» باشد.',
    },
    {
      key: 'foreignOutSwapB',
      group: 'bitswap',
      label: 'Foreign out: which bit is written',
      labelFa: 'خارج (خروجی): کدام بیت نوشته شود',
      type: 'select',
      default: 'rst',
      options: ['cwr', 'ece', 'urg', 'ack', 'psh', 'rst', 'syn', 'fin'],
    },
    {
      key: 'foreignInSwapA',
      group: 'bitswap',
      label: 'Foreign in: which bit is read',
      labelFa: 'خارج (ورودی): کدام بیت خوانده شود',
      type: 'select',
      default: 'psh',
      options: ['cwr', 'ece', 'urg', 'ack', 'psh', 'rst', 'syn', 'fin'],
    },
    {
      key: 'foreignInSwapB',
      group: 'bitswap',
      label: 'Foreign in: which bit is written',
      labelFa: 'خارج (ورودی): کدام بیت نوشته شود',
      type: 'select',
      default: 'cwr',
      options: ['cwr', 'ece', 'urg', 'ack', 'psh', 'rst', 'syn', 'fin'],
      help: 'باید دقیقاً معکوس «ایران بالا» باشد.',
    },

    // ---- raw sockets ------------------------------------------------------
    {
      key: 'iranTrashIp',
      group: 'raw',
      label: 'Iran trash capture IP',
      labelFa: 'IP بی‌استفاده ایران',
      type: 'text',
      default: '12.12.12.12/32',
      required: true,
      help: 'RawSocket روی ایران پکت‌های خروجی را با این فیلتر می‌فرستد. یک IP آدرس‌داده‌شده انتخاب کنید که هرگز واقعاً استفاده نمی‌شود.',
    },
    {
      key: 'foreignTrashIp',
      group: 'raw',
      label: 'Foreign trash capture IP',
      labelFa: 'IP بی‌استفاده خارج',
      type: 'text',
      default: '12.13.12.13',
      required: true,
    },
    {
      key: 'packetDuplicateUp',
      group: 'bitswap',
      label: 'Packet duplicate (Iran up)',
      labelFa: 'تکثیر پکت (ایران بالا)',
      type: 'number',
      default: 0,
      min: 0,
      max: 16,
      help: 'IpManipulator.packet-duplicate — تعداد کپی اضافه از پکت نهایی قبل از ارسال اصلی. ۰ یعنی غیرفعال. نسخه ۲ از این با مقدار ۳ استفاده می‌کند.',
    },
    {
      key: 'bypassConntrack',
      group: 'raw',
      label: 'Bypass conntrack',
      labelFa: 'دور زدن conntrack',
      type: 'boolean',
      default: true,
      help: 'RawSocket.bypass-conntrack — قاعده NOTRACK نصب می‌کند. پیش‌فرض و توصیه‌شده.',
    },
    {
      key: 'useVariables',
      group: 'advanced',
      label: 'Use $variables$ in the config',
      labelFa: 'استفاده از متغیرها در کانفیگ',
      type: 'boolean',
      default: true,
    },
    // coreFields() already declares _core.mtu; retarget its default to 1400.
    ...coreFields().map((f) => (f.key === '_core.mtu' ? { ...f, default: 1400 } : f)),
  ];
}

const commonWarnings = (options) => [
  'RawSocket به root یا CAP_NET_ADMIN نیاز دارد: iptables و NFQUEUE را تنظیم می‌کند و پکت‌ها را از کرنل می‌رباید.',
  'پکت‌های capture‌شده از استک شبکه میزبان حذف می‌شوند؛ اگر فیلترها اشتباه باشند ممکن است ترافیک واقعی سرور قطع شود. قبل از استقرار روی سرور اصلی تست کنید.',
  'IP بی‌استفاده (trash capture IP) نباید واقعاً استفاده شود؛ یک رنج آدرس‌داده‌شده امن است.',
  'MTU را پایین نگه دارید (پیش‌فرض ۱۴۰۰) چون دستکاری بیت‌ها و قالب‌بندی XOR روی اندازه پکت اثر می‌گذارد.',
  'این تکنیک بسیار وابسته به مسیر است. آنچه روی یک مسیر کار می‌کند ممکن است روی مسیر دیگر نادیده یا دور ریخته شود.',
  'تنظیمات TCP-bit در هر دو طرف باید دقیقاً معکوس هم باشند؛ اگر نباشند، تونل بی‌صدا کار نمی‌کند.',
];

const commonNotes = (options) => [
  `IpOverrider آدرس‌های داخلی TUN را با IP عمومی واقعی (${options.iranHost} و ${options.foreignHost}) جایگزین می‌کند، پس آدرس‌های 10.x روی سیم دیده نمی‌شوند.`,
  'PacketSplitStream دو شاخه up/down دارد و top-level next ندارد — این اجباری است.',
  'Obfuscator روی همه نودهای Obfuscator باید کلید XOR یکسان داشته باشد.',
];

// -------------------------------------------------------------------------
const bitSwap = {
  id: 'tcp-bit-swap',
  title: 'TCP Bit Swapping',
  titleFa: 'تعویض بیت‌های TCP',
  category: 'stealth',
  categoryFa: 'استتار',
  icon: '🎭',
  sides: ['iran', 'foreign'],
  summary:
    'TunDevice -> IpOverrider -> PacketSplitStream -> Obfuscator -> IpManipulator -> RawSocket on both sides, swapping TCP flag bits so the traffic no longer looks like TCP. The exit lands on a second TUN on the foreign box.',
  summaryFa:
    'ترافیک کاربر به پکت واقعی IP تبدیل می‌شود و بیت‌های کنترلی TCP روی سیم جابه‌جا می‌شوند. نتیجه: ترافیک دیگر شکل یک اتصال TCP واقعی ندارد. خروجی روی یک TUN دوم در سرور خارج تحویل داده می‌شود. نیازمند دسترسی root روی هر دو سرور.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/IpManipulator',
  tags: ['stealth', 'packets', 'raw-socket', 'tcp-flags', 'advanced'],
  clientHint: 'کاربران به پورت اعلام‌شده روی سرور ایران وصل می‌شوند؛ خروجی روی TUN دوم سرور خارج تحویل می‌گیرد.',
  fields: [
    {
      key: 'forwardPort',
      group: 'entry',
      label: 'User-facing port (Iran)',
      labelFa: 'پورت کاربران (ایران)',
      type: 'number',
      default: 443,
      min: 1,
      max: 65535,
      required: true,
      help: 'users_inbound روی این پورت گوش می‌دهد و tcp-out هم به همان پورت روی آدرس TUN طرف مقابل وصل می‌شود.',
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
    ...sharedFields(),
  ],

  build({ options }) {
    const useVars = options.useVariables !== false;
    const port = Number(options.forwardPort) || 443;
    const iranIp = options.iranHost;
    const foreignIp = options.foreignHost;
    const tunIpBase = String(options.iranTunIp).split('/')[0];
    const peerTunIp = options.iranPeerTunIp;
    const obf = obfClient(options.xorKey, options.obfSkip || 'transport');
    const bypass = { 'bypass-conntrack': options.bypassConntrack !== false };

    const iranNodes = [
      node(
        'users_inbound',
        'TcpListener',
        { address: options.listenAddress, port, nodelay: true },
        options.userTlsTermination ? 'tls_user_side' : 'tcp-out',
      ),
    ];
    if (options.userTlsTermination) iranNodes.push(userTlsNode('tcp-out'));
    iranNodes.push(
      node('tcp-out', 'TcpConnector', { address: peerTunIp, port, nodelay: true }),
      node('my tun', 'TunDevice', { 'device-name': options.iranTunName, 'device-ip': options.iranTunIp }, 'ipovsrc'),
      node(
        'ipovsrc',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: iranIp }, 'dest-ip': { ipv4: foreignIp } },
          down: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
        },
        'splitter',
      ),
      // PacketSplitStream must NOT have a top-level next.
      node('splitter', 'PacketSplitStream', { up: 'obfuscator-c', down: 'obfuscator-c2' }),
      node('obfuscator-c', 'ObfuscatorClient', obf, 'ip-manipulator-up'),
      node(
        'ip-manipulator-up',
        'IpManipulator',
        bitSettings(options, 'up', options.iranUpSwapA, options.iranUpSwapB, options.packetDuplicateUp),
        'rd',
      ),
      node('rd', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': options.iranTrashIp, ...bypass }),
      node('obfuscator-c2', 'ObfuscatorClient', obf, 'ip-manipulator'),
      node(
        'ip-manipulator',
        'IpManipulator',
        bitSettings(options, 'dw', options.iranDownSwapA, options.iranDownSwapB),
        'rd2',
      ),
      node('rd2', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': foreignIp, ...bypass }),
    );

    const iranConfig = {
      name: 'iran-tcp-bitswap',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              ip_server_iran: iranIp,
              ip_server_kharej: foreignIp,
              port_to_forward_to_kharej: port,
              tun_ip: tunIpBase,
              tun_peer_ip: peerTunIp,
              xor_key: Number(options.xorKey) || 0,
              obf_skip: options.obfSkip || 'transport',
              trash_capture_ip: options.iranTrashIp,
              tun_name: options.iranTunName,
              tun_ip_cidr: options.iranTunIp,
              ...(options.userTlsTermination
                ? { certificate_path: '/root/fullchain.pem', key_path: '/root/privkey.pem' }
                : {}),
            },
          }
        : {}),
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
          n.settings.port = '@port_to_forward_to_kharej';
        },
        users_inbound: (n) => {
          n.settings.port = '@port_to_forward_to_kharej';
        },
        'obfuscator-c': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        'obfuscator-c2': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        rd: (n) => {
          n.settings['capture-ip'] = '@trash_capture_ip';
        },
        rd2: (n) => {
          n.settings['capture-ip'] = '@ip_server_kharej';
        },
        tls_user_side: (n) => {
          n.settings['cert-file'] = '@certificate_path';
          n.settings['key-file'] = '@key_path';
        },
      }),
    };

    const foreignNodes = [
      node('my tun2', 'TunDevice', { 'device-name': options.foreignTunName, 'device-ip': options.foreignTunIp }, 'ipcorrect'),
      node(
        'ipcorrect',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
          down: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
        },
        'obfuscator-s',
      ),
      node('obfuscator-s', 'ObfuscatorServer', obfServer(options.xorKey, options.obfSkip || 'transport'), 'ip-manipulator-in'),
      node(
        'ip-manipulator-in',
        'IpManipulator',
        bitSettings(options, 'dw', options.foreignInSwapA, options.foreignInSwapB),
        'rdin',
      ),
      node('rdin', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': iranIp, ...bypass }),
      node('my tun', 'TunDevice', { 'device-name': options.iranTunName, 'device-ip': options.iranTunIp }, 'ipovsrc'),
      node(
        'ipovsrc',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: foreignIp }, 'dest-ip': { ipv4: iranIp } },
          down: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
        },
        'obfuscator-c',
      ),
      node('obfuscator-c', 'ObfuscatorClient', obf, 'ip-manipulator'),
      node(
        'ip-manipulator',
        'IpManipulator',
        bitSettings(options, 'up', options.foreignOutSwapA, options.foreignOutSwapB),
        'rd',
      ),
      node('rd', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': options.foreignTrashIp, ...bypass }),
    ];

    const foreignConfig = {
      name: 'foreign-tcp-bitswap',
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
              trash_capture_ip: options.foreignTrashIp,
              tun_name: options.iranTunName,
              tun_ip_cidr: options.iranTunIp,
            },
          }
        : {}),
      nodes: withVarSentinels(foreignNodes, {
        'my tun': (n) => {
          n.settings['device-name'] = '@tun_name';
          n.settings['device-ip'] = '@tun_ip_cidr';
        },
        ipovsrc: (n) => {
          n.settings.up['source-ip'].ipv4 = '@ip_server_kharej';
          n.settings.up['dest-ip'].ipv4 = '@ip_server_iran';
          n.settings.down['source-ip'].ipv4 = '@tun_peer_ip';
          n.settings.down['dest-ip'].ipv4 = '@tun_ip';
        },
        ipcorrect: (n) => {
          n.settings.up['source-ip'].ipv4 = '@tun_peer_ip';
          n.settings.up['dest-ip'].ipv4 = '@tun_ip';
          n.settings.down['source-ip'].ipv4 = '@tun_peer_ip';
          n.settings.down['dest-ip'].ipv4 = '@tun_ip';
        },
        'obfuscator-s': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        'obfuscator-c': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        rdin: (n) => {
          n.settings['capture-ip'] = '@ip_server_iran';
        },
        rd: (n) => {
          n.settings['capture-ip'] = '@trash_capture_ip';
        },
      }),
    };

    return {
      iran: { core: coreOpts(options, { mtu: Number(options.deviceMtu) || 1400, ramProfile: 'server' }), files: { 'configs/tcp-bit-swap.json': emit(iranConfig, options) } },
      foreign: { core: coreOpts(options, { mtu: Number(options.deviceMtu) || 1400, ramProfile: 'server' }), files: { 'configs/tcp-bit-swap.json': emit(foreignConfig, options) } },
      client: {
        links: [
          {
            label: 'نقطه ورود کاربران (ایران)',
            url: `${options.listenAddress === '0.0.0.0' ? iranIp : options.listenAddress}:${port}`,
          },
        ],
        instructions: [
          `کاربران به ${iranIp}:${port} وصل می‌شوند. خروجی روی سرور خارج از طریق TUN دوم (${options.foreignTunName}) تحویل داده می‌شود.`,
          'روی سرور خارج باید یک سرویس روی TUN دوم گوش بدهد تا ترافیک کاربران را تحویل بگیرد.',
        ],
      },
      notes: [
        `جریان کاربر: ${iranIp}:${port} → users_inbound → tcp-out → TUN مشترک → IpOverrider → PacketSplitStream → ObfuscatorClient → IpManipulator → RawSocket`,
        ...commonNotes(options),
      ],
      warnings: commonWarnings(options),
    };
  },
};

// -------------------------------------------------------------------------
const bitSwapMux = {
  id: 'tcp-bit-swap-mux',
  title: 'TCP Bit Swapping + Mux',
  titleFa: 'تعویض بیت‌های TCP به‌همراه Mux',
  category: 'stealth',
  categoryFa: 'استتار',
  icon: '🧬',
  sides: ['iran', 'foreign'],
  summary:
    'Same packet machinery as tcp-bit-swap, with a MuxClient in front of the packet conversion and a MuxServer on the foreign side that forwards to a real local service (for example xray).',
  summaryFa:
    'همان ماشین پکت تعویض بیت، ولی یک لایه Mux قبل از تبدیل به پکت اضافه شده. چند اتصال منطقی روی چند اتصال فیزیکی به‌اشتراک گذاشته می‌شود و خروجی روی سرور خارج به یک سرویس واقعی محلی (مثلاً xray) می‌رسد.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/MuxClient',
  tags: ['stealth', 'packets', 'raw-socket', 'mux', 'advanced'],
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی روی سرویس محلی سرور خارج (مثلاً xray) است.',
  fields: [
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
      help: 'users_inbound روی سرور ایران.',
    },
    { key: 'listenAddress', group: 'entry', label: 'Bind address (Iran)', labelFa: 'آدرس bind (ایران)', type: 'text', default: '0.0.0.0' },
    {
      key: 'userTlsTermination',
      group: 'entry',
      label: 'Terminate TLS for users',
      labelFa: 'خاتمه TLS برای کاربران',
      type: 'boolean',
      default: false,
      help: 'اگر روشن باشد یک TlsServer بین users_inbound و MuxClient قرار می‌گیرد.',
    },
    {
      key: 'muxConnectionsPerWorker',
      group: 'mux',
      label: 'Mux connections per worker',
      labelFa: 'اتصال Mux به ازای هر ورکر',
      type: 'number',
      default: 8,
      min: 1,
      required: true,
      help: 'MuxClient.per-worker-connections-count — تعداد نهایی این عدد ضربدر تعداد workers است. پیش‌فرض فایل مرجع ۸ است.',
    },
    {
      key: 'muxMaxChildren',
      group: 'mux',
      label: 'Max mux children',
      labelFa: 'حداکثر فرزند Mux',
      type: 'number',
      default: 10000,
      min: 1,
      help: 'MuxServer.max-children. خالی بگذارید تا پیش‌فرض واتروال استفاده شود.',
    },
    {
      key: 'waterwallPort',
      group: 'mux',
      label: 'WaterWall port on foreign (Iran → foreign)',
      labelFa: 'پورت واتروال در خارج',
      type: 'number',
      default: 443,
      min: 1,
      max: 65535,
      required: true,
      help: 'این پورت روی سرور خارج، ورودی MuxServer است — نه پورت نهایی xray.',
    },
    {
      key: 'finalAddress',
      group: 'service',
      label: 'Final service address (foreign)',
      labelFa: 'آدرس سرویس نهایی (خارج)',
      type: 'text',
      default: '127.0.0.1',
      required: true,
      help: 'خروجی ترافیک روی سرور خارج به این آدرس می‌رود. برای xray محلی همان 127.0.0.1 بماند.',
    },
    {
      key: 'finalPort',
      group: 'service',
      label: 'Final service port (foreign)',
      labelFa: 'پورت سرویس نهایی (خارج)',
      type: 'number',
      default: 2083,
      min: 1,
      max: 65535,
      required: true,
      help: 'پورت inbound سرویس محلی (مثلاً xray) روی سرور خارج.',
    },
    ...sharedFields(),
  ],

  build({ options }) {
    const useVars = options.useVariables !== false;
    const listenPort = Number(options.listenPort) || 443;
    const wwPort = Number(options.waterwallPort) || 443;
    const iranIp = options.iranHost;
    const foreignIp = options.foreignHost;
    const tunIpBase = String(options.iranTunIp).split('/')[0];
    const peerTunIp = options.iranPeerTunIp;
    const obf = obfClient(options.xorKey, options.obfSkip || 'transport');
    const bypass = { 'bypass-conntrack': options.bypassConntrack !== false };

    const muxClientSettings = {
      mode: 'fixed-connections-count',
      'per-worker-connections-count': Number(options.muxConnectionsPerWorker) || 8,
    };
    const muxServerSettings = {};
    if (Number(options.muxMaxChildren) > 0) muxServerSettings['max-children'] = Number(options.muxMaxChildren);

    const iranNodes = [
      node(
        'users_inbound',
        'TcpListener',
        { address: options.listenAddress, port: listenPort, nodelay: true },
        options.userTlsTermination ? 'tls_user_side' : 'mux-client',
      ),
    ];
    if (options.userTlsTermination) iranNodes.push(userTlsNode('mux-client'));
    iranNodes.push(
      node('mux-client', 'MuxClient', muxClientSettings, 'tcp-out'),
      node('tcp-out', 'TcpConnector', { address: peerTunIp, port: wwPort, nodelay: true }),
      node('my tun', 'TunDevice', { 'device-name': options.iranTunName, 'device-ip': options.iranTunIp }, 'ipovsrc'),
      node(
        'ipovsrc',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: iranIp }, 'dest-ip': { ipv4: foreignIp } },
          down: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
        },
        'splitter',
      ),
      // PacketSplitStream must NOT have a top-level next.
      node('splitter', 'PacketSplitStream', { up: 'obfuscator-c', down: 'obfuscator-s' }),
      node('obfuscator-c', 'ObfuscatorClient', obf, 'ip-manipulator-up'),
      node(
        'ip-manipulator-up',
        'IpManipulator',
        bitSettings(options, 'up', options.iranUpSwapA, options.iranUpSwapB, options.packetDuplicateUp),
        'rd',
      ),
      node('rd', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': options.iranTrashIp, ...bypass }),
      node('obfuscator-s', 'ObfuscatorServer', obfServer(options.xorKey, options.obfSkip || 'transport'), 'ip-manipulator'),
      node(
        'ip-manipulator',
        'IpManipulator',
        bitSettings(options, 'dw', options.iranDownSwapA, options.iranDownSwapB),
        'rd2',
      ),
      node('rd2', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': foreignIp, ...bypass }),
    );

    const iranConfig = {
      name: 'iran-tcp-bitswap-mux',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              ip_server_iran: iranIp,
              ip_server_kharej: foreignIp,
              port_to_listen: listenPort,
              port_to_connect_to_kharej: wwPort,
              each_worker_mux_connections_count: Number(options.muxConnectionsPerWorker) || 8,
              tun_ip: tunIpBase,
              tun_peer_ip: peerTunIp,
              xor_key: Number(options.xorKey) || 0,
              obf_skip: options.obfSkip || 'transport',
              trash_capture_ip: options.iranTrashIp,
              tun_name: options.iranTunName,
              tun_ip_cidr: options.iranTunIp,
              ...(options.userTlsTermination
                ? { certificate_path: '/root/fullchain.pem', key_path: '/root/privkey.pem' }
                : {}),
            },
          }
        : {}),
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
          n.settings.port = '@port_to_connect_to_kharej';
        },
        users_inbound: (n) => {
          n.settings.port = '@port_to_listen';
        },
        'mux-client': (n) => {
          n.settings['per-worker-connections-count'] = '@each_worker_mux_connections_count';
        },
        'obfuscator-c': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        'obfuscator-s': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        rd: (n) => {
          n.settings['capture-ip'] = '@trash_capture_ip';
        },
        rd2: (n) => {
          n.settings['capture-ip'] = '@ip_server_kharej';
        },
        tls_user_side: (n) => {
          n.settings['cert-file'] = '@certificate_path';
          n.settings['key-file'] = '@key_path';
        },
      }),
    };

    const foreignNodes = [
      node('users_inbound', 'TcpListener', { address: '0.0.0.0', port: wwPort, nodelay: true }, 'mux-s'),
      node('mux-s', 'MuxServer', muxServerSettings, 'tcp-out'),
      node('tcp-out', 'TcpConnector', {
        address: options.finalAddress || '127.0.0.1',
        port: Number(options.finalPort) || 2083,
        nodelay: true,
      }),
      node('my tun2', 'TunDevice', { 'device-name': options.foreignTunName, 'device-ip': options.foreignTunIp }, 'ipcorrect'),
      node(
        'ipcorrect',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
          down: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
        },
        'obfuscator-s',
      ),
      node('obfuscator-s', 'ObfuscatorServer', obfServer(options.xorKey, options.obfSkip || 'transport'), 'ip-manipulator-in'),
      node(
        'ip-manipulator-in',
        'IpManipulator',
        bitSettings(options, 'dw', options.foreignInSwapA, options.foreignInSwapB),
        'rdin',
      ),
      node('rdin', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': iranIp, ...bypass }),
      node('my tun', 'TunDevice', { 'device-name': options.iranTunName, 'device-ip': options.iranTunIp }, 'ipovsrc'),
      node(
        'ipovsrc',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: foreignIp }, 'dest-ip': { ipv4: iranIp } },
          down: { 'source-ip': { ipv4: peerTunIp }, 'dest-ip': { ipv4: tunIpBase } },
        },
        'obfuscator-c',
      ),
      node('obfuscator-c', 'ObfuscatorClient', obf, 'ip-manipulator'),
      node(
        'ip-manipulator',
        'IpManipulator',
        bitSettings(options, 'up', options.foreignOutSwapA, options.foreignOutSwapB),
        'rd',
      ),
      node('rd', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': options.foreignTrashIp, ...bypass }),
    ];

    const foreignConfig = {
      name: 'foreign-tcp-bitswap-mux',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              ip_server_iran: iranIp,
              ip_server_kharej: foreignIp,
              port_to_listen: wwPort,
              final_ip: options.finalAddress || '127.0.0.1',
              final_port: Number(options.finalPort) || 2083,
              each_worker_mux_connections_count: Number(options.muxConnectionsPerWorker) || 8,
              tun_ip: tunIpBase,
              tun_peer_ip: peerTunIp,
              xor_key: Number(options.xorKey) || 0,
              obf_skip: options.obfSkip || 'transport',
              trash_capture_ip: options.foreignTrashIp,
              tun_name: options.iranTunName,
              tun_ip_cidr: options.iranTunIp,
            },
          }
        : {}),
      nodes: withVarSentinels(foreignNodes, {
        'my tun': (n) => {
          n.settings['device-name'] = '@tun_name';
          n.settings['device-ip'] = '@tun_ip_cidr';
        },
        ipovsrc: (n) => {
          n.settings.up['source-ip'].ipv4 = '@ip_server_kharej';
          n.settings.up['dest-ip'].ipv4 = '@ip_server_iran';
          n.settings.down['source-ip'].ipv4 = '@tun_peer_ip';
          n.settings.down['dest-ip'].ipv4 = '@tun_ip';
        },
        ipcorrect: (n) => {
          n.settings.up['source-ip'].ipv4 = '@tun_peer_ip';
          n.settings.up['dest-ip'].ipv4 = '@tun_ip';
          n.settings.down['source-ip'].ipv4 = '@tun_peer_ip';
          n.settings.down['dest-ip'].ipv4 = '@tun_ip';
        },
        'obfuscator-s': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        'obfuscator-c': (n) => {
          n.settings.xor_key = '@xor_key';
          n.settings.skip = '@obf_skip';
        },
        'tcp-out': (n) => {
          n.settings.address = '@final_ip';
          n.settings.port = '@final_port';
        },
        users_inbound: (n) => {
          n.settings.port = '@port_to_listen';
        },
        rdin: (n) => {
          n.settings['capture-ip'] = '@ip_server_iran';
        },
        rd: (n) => {
          n.settings['capture-ip'] = '@trash_capture_ip';
        },
      }),
    };

    return {
      iran: { core: coreOpts(options, { mtu: Number(options.deviceMtu) || 1400, ramProfile: 'server' }), files: { 'configs/tcp-bit-swap-mux.json': emit(iranConfig, options) } },
      foreign: { core: coreOpts(options, { mtu: Number(options.deviceMtu) || 1400, ramProfile: 'server' }), files: { 'configs/tcp-bit-swap-mux.json': emit(foreignConfig, options) } },
      client: {
        links: [
          {
            label: 'نقطه ورود کلاینت Mux (ایران)',
            url: `${options.listenAddress === '0.0.0.0' ? iranIp : options.listenAddress}:${listenPort}`,
            hint: 'کلاینت شما می‌تواند Mux را فعال کند؛ خود واتروال هم بین کاربران و سرور multiplexing می‌کند.',
          },
        ],
        instructions: [
          `کاربران به ${iranIp}:${listenPort} وصل می‌شوند. خروجی روی سرور خارج به ${options.finalAddress || '127.0.0.1'}:${options.finalPort || 2083} می‌رسد (سرویس محلی، مثلاً xray).`,
          `پورت ${wwPort} روی سرور خارج ورودی MuxServer است و نباید عمومی باشد؛ فقط از IP سرور ایران باز باشد.`,
        ],
      },
      notes: [
        `جریان کاربر: ${iranIp}:${listenPort} → users_inbound → MuxClient → tcp-out → TUN مشترک → IpOverrider → PacketSplitStream → Obfuscator → IpManipulator → RawSocket`,
        `روی سرور خارج، RawSocket پکت‌ها را تحویل می‌دهد و دوباره به users_inbound:${wwPort} → MuxServer → ${options.finalAddress || '127.0.0.1'}:${options.finalPort || 2083} می‌رسند.`,
        `MuxClient در حالت fixed-connections-count با ${Number(options.muxConnectionsPerWorker) || 8} اتصال به‌ازای هر ورکر کار می‌کند؛ تعداد نهایی این عدد ضربدر misc.workers است.`,
        `شاخه down ایران در این نسخه ObfuscatorServer است (نه ObfuscatorClient)، چون سمت مقابل روی همان مسیر ObfuscatorClient دارد.`,
        ...commonNotes(options),
      ],
      warnings: [
        `پورت ${wwPort} روی سرور خارج (ورودی MuxServer) و پورت سرویس نهایی (${options.finalPort || 2083}) نباید عمومی باشند؛ فقط IP سرور ایران را در فایروال مجاز کنید.`,
        `تعداد اتصال نهایی = ${Number(options.muxConnectionsPerWorker) || 8} × misc.workers. اگر workers را زیاد کنید، ممکن است از حد رابطه‌های TCP عبور کنید.`,
        ...commonWarnings(options),
      ],
    };
  },
};

// -------------------------------------------------------------------------
// Variant 2 is bitSwapMux with the ECN-adjacent flag pair (URG/ECE) instead of
// CWR/RST, plus packet duplication on the Iran up path. CWR and RST carry
// meaning of their own (congestion window reduction, connection reset), so
// emitting them on unrelated traffic is more likely to be flagged; URG/ECE are
// less conspicuous. The duplication makes the observer's view of the stream
// ambiguous.
const bitSwapMux2 = {
  ...bitSwapMux,
  id: 'tcp-bit-swap-mux-2',
  title: 'TCP Bit Swapping + Mux (variant 2)',
  titleFa: 'تعویض بیت‌های TCP به‌همراه Mux (نسخه ۲)',
  icon: '🧬',
  summary:
    'Same as tcp-bit-swap-mux, but the up path swaps PSH/URG and the down path swaps PSH/ECE, and the Iran up path also duplicates each packet three times.',
  summaryFa:
    'همان نسخه ۱، ولی در مسیر بالا PSH با URG و در مسیر پایین PSH با ECE جابه‌جا می‌شود، و پکت‌های مسیر بالا سه بار تکثیر می‌شوند. بیت‌های URG/ECE کمتر از CWR/RST توجه ناظر را جلب می‌کنند چون معنای مستقلی ندارند.',
  tags: ['stealth', 'packets', 'raw-socket', 'mux', 'duplicate', 'advanced'],
  fields: bitSwapMux.fields
    .map((f) => {
      if (f.key === 'iranUpSwapB') return { ...f, default: 'urg', help: 'در نسخه ۲ مقدار پیش‌فرض URG است. سمت خارج خودکار معکوس همین را می‌خواند.' };
      if (f.key === 'iranDownSwapB') return { ...f, default: 'ece', help: 'در نسخه ۲ مقدار پیش‌فرض ECE است. سمت خارج خودکار معکوس همین را می‌خواند.' };
      if (f.key === 'packetDuplicateUp') {
        return { ...f, default: 3, help: 'IpManipulator.packet-duplicate — نسخه ۲ چند کپی اضافه می‌فرستد تا نمای ناظر مبهم شود. ۰ یعنی غیرفعال.' };
      }
      // The foreign swaps are derived from the Iran ones, so they are not
      // shown: editing one side only would break the mirror.
      if (f.key.startsWith('foreignIn') || f.key.startsWith('foreignOut')) return null;
      return f;
    })
    .filter(Boolean),

  build(ctx) {
    // Both ends must agree, so the foreign side's swaps are derived from the
    // Iran side's: whatever Iran writes, foreign reads back and vice versa.
    const o = { ...ctx.options };
    o.foreignInSwapA = o.iranUpSwapA;
    o.foreignInSwapB = o.iranUpSwapB;
    o.foreignOutSwapA = o.iranDownSwapA;
    o.foreignOutSwapB = o.iranDownSwapB;

    const result = bitSwapMux.build({ ...ctx, options: o });
    return {
      ...result,
      notes: [
        ...result.notes,
        'در این نسخه بیت‌های URG و ECE استفاده می‌شوند (نه CWR و RST). این بیت‌ها در TCP معنای مستقلی ندارند، بنابراین کمتر برای ناظر قابل تشخیص‌اند.',
        'packet-duplicate روی ip-manipulator-up فعال است: هر پکت چند بار به‌علاوه اصل ارسال می‌شود تا بازسازی جریان نزد ناظر مبهم شود.',
      ],
    };
  },
};

module.exports = [bitSwap, bitSwapMux, bitSwapMux2];
