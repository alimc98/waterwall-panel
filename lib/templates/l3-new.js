'use strict';

const { CERT_PATH, KEY_PATH } = require('../certs');

/**
 * Packet-to-connection bridges.
 *
 * WaterWall 1.46.96 made the packet -> connection path practical: a TunDevice
 * can now feed an in-process lwIP stack and the resulting TCP/UDP flows can
 * leave as ordinary stream lines. That is tun2socks behaviour, and it is the
 * cheapest way to tunnel *arbitrary* system traffic without WireGuard.
 *
 * Also here: the Ping v2 carrier, which only exists in 1.46.96. Ping v1 and v2
 * are not wire compatible, and v2 rejects every v1 setting outright.
 */

const { coreFields, coreOpts, destFields, node } = require('./common');
const { chainConfig, emitConfig } = require('../generator');

const emit = (config, options) => emitConfig(config, { useVariables: options.useVariables !== false });
const j = (config, options) => emit(config, options);

const secretFields = [
  { key: 'sni', group: 'secret', label: 'SNI / server name', labelFa: 'SNI', type: 'text', default: 'example.com' },
  { key: 'verify', group: 'secret', label: 'Verify certificate', labelFa: 'بررسی گواهی', type: 'boolean', default: true },
  {
    key: 'password',
    group: 'secret',
    label: 'Shared password (AEAD)',
    labelFa: 'رمز مشترک (AEAD)',
    type: 'password',
    default: 'auto:password',
    required: true,
  },
  { key: 'salt', group: 'secret', label: 'Salt', labelFa: 'Salt', type: 'text', default: 'ww-panel' },
];

// ---------------------------------------------------------------------------
// 1. tun2socks
// ---------------------------------------------------------------------------

/**
 *   Iran     TunDevice -> PacketsToConnection -> Socks5Client -> TlsClient -> TcpConnector
 *   Foreign  TcpListener -> TlsServer -> Socks5Server -> TcpConnector
 *
 * Every TCP/UDP flow the operating system sends into the TUN is reconstructed
 * by lwIP and leaves as a normal WaterWall line, so arbitrary system traffic
 * (not just one app) can be tunnelled without WireGuard.
 *
 * The important operational detail: this needs a routing rule so packets reach
 * the TUN without looping back into it. Routing the whole default gateway at
 * the TUN while the tunnel's own packets also enter the TUN is exactly the loop
 * the panel warns about.
 */
const tun2socks = {
  id: 'tun2socks',
  title: 'TUN to SOCKS over a tunnel (tun2socks)',
  titleFa: 'TUN به SOCKS روی تونل (tun2socks)',
  category: 'layer3',
  categoryFa: 'لایه ۳',
  icon: '🔁',
  sides: ['iran', 'foreign'],
  minVersion: '1.46.96',
  summary:
    'TunDevice -> PacketsToConnection -> Socks5Client -> TlsClient -> TcpConnector. Arbitrary system traffic goes in, normal stream lines come out.',
  summaryFa:
    'ترافیک سیستم‌عامل از TUN وارد می‌شود، lwIP آن را به اتصال‌های واقعی TCP/UDP تبدیل می‌کند و این اتصال‌ها به‌صورت خط‌های معمولی واتروال از تونل بیرون می‌روند. برخلاف WireGuard نیازی به نصب ماژول کرنل نیست.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/PacketsToConnection',
  tags: ['tun', 'tun2socks', 'lwip', 'socks5', 'layer3', 'system-traffic'],
  clientHint:
    'کل ترافیک سیستمِ سرور ایران از TUN عبور می‌کند؛ کاربری روی سرور خارج لازم نیست.',
  fields: [
    {
      key: 'tunName',
      group: 'tun',
      label: 'TUN device name',
      labelFa: 'نام دستگاه TUN',
      type: 'text',
      default: 'wtun1',
      required: true,
    },
    {
      key: 'tunIp',
      group: 'tun',
      label: 'TUN IPv4 (CIDR)',
      labelFa: 'آدرس TUN (CIDR)',
      type: 'text',
      default: '10.10.0.1/24',
      required: true,
      help: 'همان آدرسی که به دستگاه TUN می‌دهید.',
    },
    {
      key: 'tunMtu',
      group: 'tun',
      label: 'TUN MTU',
      labelFa: 'MTU دستگاه TUN',
      type: 'number',
      default: 1400,
      min: 68,
      max: 65535,
      help: 'کمتر از MTU لینک TLS تا پکت‌ها روی مسیر شکسته نشوند.',
    },
    { key: 'listenAddress', group: 'entry', label: 'Bind address (Iran)', labelFa: 'آدرس bind (ایران)', type: 'text', default: '0.0.0.0' },
    {
      key: 'linkPort',
      group: 'entry',
      label: 'Server link port (Iran)',
      labelFa: 'پورت لینک بین دو سرور (ایران)',
      type: 'number',
      default: 2053,
      min: 1,
      max: 65535,
      required: true,
    },
    { key: 'foreignSocksHost', group: 'entry', label: 'SOCKS5 host (foreign)', labelFa: 'آدرس SOCKS5 (خارج)', type: 'text', default: '127.0.0.1' },
    { key: 'foreignSocksPort', group: 'entry', label: 'SOCKS5 port (foreign)', labelFa: 'پورت SOCKS5 (خارج)', type: 'number', default: 1080, min: 1, max: 65535 },
    ...destFields(),
    ...secretFields,
    ...coreFields().map((f) => (f.key === '_core.mtu' ? { ...f, default: 1400 } : f)),
  ],

  build({ options }) {
    const linkPort = Number(options.linkPort) || 2053;

    const iranNodes = [
      node('tun', 'TunDevice', { 'device-name': options.tunName, 'device-ip': options.tunIp }, 'ptc'),
      node(
        'ptc',
        'PacketsToConnection',
        { mtu: Number(options.tunMtu) || 1400 },
        'socks-c',
      ),
      // dest_context / line->dest_ctx carries the original destination, so the
      // foreign SOCKS5 server connects to the real target rather than a fixed one.
      node(
        'socks-c',
        'Socks5Client',
        { address: 'dest_context->address', port: 'dest_context->port' },
        'tls-c',
      ),
      node('tls-c', 'TlsClient', { sni: options.sni, verify: options.verify !== false }, 'out'),
      node('out', 'TcpConnector', { address: options.foreignHost, port: linkPort, nodelay: true }),
    ];

    const foreignNodes = [
      node(
        'public',
        'TcpListener',
        { address: '0.0.0.0', port: linkPort, nodelay: true, whitelist: [`${options.iranHost}/32`] },
        'tls-s',
      ),
      node('tls-s', 'TlsServer', { 'cert-file': CERT_PATH, 'key-file': KEY_PATH, sni: options.sni }, 'socks-s'),
      node(
        'socks-s',
        'Socks5Server',
        {
          address: options.foreignSocksHost,
          port: Number(options.foreignSocksPort),
          'no-auth': true,
          udp: false,
        },
        'out',
      ),
      node('out', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort), nodelay: true }),
    ];

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'server', mtu: Number(options.tunMtu) || 1400 }),
        files: { 'configs/tun2socks.json': j(chainConfig('tun2socks-iran', iranNodes), options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: { 'configs/tun2socks.json': j(chainConfig('tun2socks-foreign', foreignNodes), options) },
      },
      client: {
        links: [{ label: 'TUN روی سرور ایران', url: `${options.tunName} → ${options.tunIp}` }],
        instructions: [
          `دستگاه TUN با نام ${options.tunName} روی سرور ایران ساخته می‌شود.`,
          'برای اینکه ترافیک سیستم واقعاً وارد آن شود باید یک قانون مسیریابی بنویسید (مثلاً جدول Policy Routing یا یک قانون NAT که فقط ترافیک برنامه‌های هدف را به TUN بفرستد).',
          `روی سرور خارج یک سرویس SOCKS5 روی ${options.foreignSocksHost}:${options.foreignSocksPort} باید در حال شنود باشد.`,
        ],
      },
      notes: [
        'ترتیب درست: TunDevice → PacketsToConnection → Socks5Client → TcpUdpConnector.',
        'PacketsToConnection یک پل واقعی روی lwIP است، نه یک آداپتور قاب‌بندی؛ جریان‌های TCP/UDP واقعی بازسازی می‌شوند.',
        `MTU دستگاه ${options.tunMtu} است؛ lwIP بر اساس همین مقدار fragment می‌کند.`,
        'Socks5Client با dest_context->address/port کار می‌کند تا مقصد واقعی هر جریان حفظ شود.',
        'پیاده‌سازی فعلی روی IPv4 متمرکز است.',
      ],
      warnings: [
        'بدون قانون مسیریابی روی سرور ایران، ترافیک هیچ‌وقت وارد TUN نمی‌شود و تونل بی‌اثر است.',
        'اگر کل ترافیک سیستم را به TUN بفرستید در حالی که بسته‌های خود تونل هم از همان TUN عبور کنند، حلقه مسیریابی می‌سازید و اتصال قطع می‌شود. مسیر ترافیک خود تونل را از TUN مستثنا کنید.',
        'این مسیر در نسخه ۱.46.96 عملی شده است؛ روی نسخه‌های قدیمی‌تر کار نمی‌کند.',
        'MTU نامعتبر (خارج از بازه ۶۸ تا ۶۵۵۳۵ یا اعشاری) باعث رد شدن ساخت نود می‌شود.',
        `روی سرور خارج باید SOCKS5 روی ${options.foreignSocksHost}:${options.foreignSocksPort} در حال شنود باشد؛ در غیر این صورت اتصال‌ها بی‌صدا بسته می‌شوند.`,
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// 2. ping-tunnel
// ---------------------------------------------------------------------------

/**
 * `PingClient` / `PingServer` in v2. The carrier is a fresh IPv4 + ICMP Echo
 * header per packet, with the real packet nested inside, so a network that
 * lets ICMP through but blocks the port will still carry the tunnel.
 *
 * v2 settings are a closed set: local-ipv4, peer-ipv4, send-replies,
 * identifier, sequence-start, ttl, tos. Anything else — including every v1
 * strategy key — is rejected with a migration error, and the two versions are
 * not wire compatible.
 *
 * Note the addresses are reversed between the two ends: each node's
 * `local-ipv4` is the one it presents, and `peer-ipv4` is what it expects from
 * the other side.
 */
const pingTunnel = {
  id: 'ping-tunnel',
  title: 'ICMP Ping Tunnel (Ping v2)',
  titleFa: 'تونل ICMP (Ping نسخه ۲)',
  category: 'stealth',
  categoryFa: 'استتار',
  icon: '📡',
  sides: ['iran', 'foreign'],
  minVersion: '1.46.96',
  summary:
    'PingClient / PingServer v2. Traffic is carried inside ICMP Echo packets, so a network that blocks the port but allows ICMP still passes it.',
  summaryFa:
    'ترافیک داخل بسته‌های ICMP Echo جاسازی می‌شود، بنابراین شبکه‌ای که پورت را می‌بندد ولی ICMP را باز گذاشته باشد همچنان تونل را عبور می‌دهد. فقط IPv4 و هر دو سمت باید نسخه ۲ داشته باشند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/PingClient',
  tags: ['icmp', 'ping', 'stealth', 'packet', 'raw-socket', 'ipv4'],
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی روی TUN دوم سرور خارج تحویل می‌گیرد.',
  fields: [
    { key: 'userPort', group: 'entry', label: 'User-facing port (Iran)', labelFa: 'پورت کاربران (ایران)', type: 'number', default: 443, min: 1, max: 65535, required: true },
    { key: 'tunName', group: 'tun', label: 'TUN name (foreign)', labelFa: 'نام TUN (خارج)', type: 'text', default: 'wtun1' },
    { key: 'tunIp', group: 'tun', label: 'TUN IPv4 (foreign)', labelFa: 'آدرس TUN (خارج)', type: 'text', default: '10.10.0.2/24' },
    { key: 'iranPeerIp', group: 'tun', label: 'Peer TUN IPv4', labelFa: 'آدرس TUN مقابل', type: 'text', default: '10.10.0.1' },
    {
      key: 'sendReplies',
      group: 'carrier',
      label: 'Send Echo Replies',
      labelFa: 'ارسال پاسخ Echo',
      type: 'boolean',
      default: false,
      help: 'با روشن بودن، پاسخ دقیق Echo برگردانده می‌شود و تأخیر تشخیصی کم می‌شود؛ ولی ترافیک دوطرفه می‌شود.',
    },
    {
      key: 'ttl',
      group: 'carrier',
      label: 'TTL',
      labelFa: 'TTL',
      type: 'number',
      default: 64,
      min: 1,
      max: 255,
      help: 'TTL بسته‌های تولیدشده به‌صورت محلی.',
    },
    {
      key: 'identifier',
      group: 'carrier',
      label: 'Identifier (0-65535, 0 = random)',
      labelFa: 'شناسه (۰ تا ۶۵۵۳۵، صفر = تصادفی)',
      type: 'number',
      default: 0,
      min: 0,
      max: 65535,
    },
    {
      key: 'sequenceStart',
      group: 'carrier',
      label: 'Sequence start',
      labelFa: 'شروع sequence',
      type: 'number',
      default: 1,
      min: 0,
      max: 65535,
    },
    { key: 'xorKey', group: 'carrier', label: 'XOR key (0-255)', labelFa: 'کلید XOR', type: 'number', default: 90, min: 0, max: 255 },
    { key: 'obfSkip', group: 'carrier', label: 'Obfuscator skip', labelFa: 'حالت skip ابfuscator', type: 'select', default: 'transport', options: ['none', 'ipv4', 'transport'] },
    { key: 'deviceMtu', group: 'carrier', label: 'MTU', labelFa: 'MTU', type: 'number', default: 1400, min: 68, max: 65535 },
    ...coreFields().map((f) => (f.key === '_core.mtu' ? { ...f, default: 1400 } : f)),
  ],

  build({ options }) {
    const userPort = Number(options.userPort) || 443;
    const sendReplies = options.sendReplies !== false;
    // v2 has exactly these keys and nothing else. Both ends must agree.
    const pingSettings = {
      'local-ipv4': options.iranHost,
      'peer-ipv4': options.foreignHost,
      'send-replies': sendReplies,
      identifier: Number(options.identifier) || 0,
      'sequence-start': Number(options.sequenceStart) || 0,
      ttl: Number(options.ttl) || 64,
      tos: 0,
    };
    // On the foreign side the addresses swap: each node is local at its own box.
    const foreignPing = { ...pingSettings, 'local-ipv4': options.foreignHost, 'peer-ipv4': options.iranHost };

    const obf = (key, skip) => ({ method: 'xor', xor_key: Number(key) || 0, skip });

    const iranNodes = [
      node('users_inbound', 'TcpListener', { address: '0.0.0.0', port: userPort, nodelay: true }, 'tcp-out'),
      node('tcp-out', 'TcpConnector', { address: options.iranPeerIp, port: userPort, nodelay: true }),
      node('ipovsrc', 'IpOverrider', {
        up: { 'source-ip': { ipv4: options.iranHost }, 'dest-ip': { ipv4: options.foreignHost } },
        down: { 'source-ip': { ipv4: options.iranPeerIp }, 'dest-ip': { ipv4: String(options.tunIp).split('/')[0] } },
      }, 'obfuscator-c'),
      node('obfuscator-c', 'ObfuscatorClient', obf(options.xorKey, options.obfSkip), 'ping-c'),
      node('ping-c', 'PingClient', pingSettings, 'rd'),
      node('rd', 'RawSocket', {
        'capture-filter-mode': 'source-ip',
        'capture-ip': options.foreignHost,
        'bypass-conntrack': true,
      }),
    ];

    const foreignNodes = [
      node('tun', 'TunDevice', { 'device-name': options.tunName, 'device-ip': options.tunIp }, 'ipcorrect'),
      node('ipcorrect', 'IpOverrider', {
        up: { 'source-ip': { ipv4: options.foreignHost }, 'dest-ip': { ipv4: options.iranHost } },
        down: { 'source-ip': { ipv4: options.iranPeerIp }, 'dest-ip': { ipv4: String(options.tunIp).split('/')[0] } },
      }, 'obfuscator-s'),
      node('obfuscator-s', 'ObfuscatorServer', obf(options.xorKey, options.obfSkip), 'ping-s'),
      node('ping-s', 'PingServer', foreignPing, 'rdin'),
      node('rdin', 'RawSocket', {
        'capture-filter-mode': 'source-ip',
        'capture-ip': options.iranHost,
        'bypass-conntrack': true,
      }),
    ];

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'server', mtu: Number(options.deviceMtu) || 1400 }),
        files: { 'configs/ping-tunnel.json': j(chainConfig('ping-tunnel-iran', iranNodes), options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server', mtu: Number(options.deviceMtu) || 1400 }),
        files: { 'configs/ping-tunnel.json': j(chainConfig('ping-tunnel-foreign', foreignNodes), options) },
      },
      client: {
        links: [{ label: 'نقطه ورود کاربران (ایران)', url: `${options.iranHost}:${userPort}` }],
        instructions: [
          `کاربران به ${options.iranHost}:${userPort} وصل می‌شوند.`,
          'روی سرور خارج باید سرویسی روی TUN دوم گوش بدهد تا ترافیک کاربران را تحویل بگیرد.',
        ],
      },
      notes: [
        'حامل، یک هدر تازه IPv4 به‌علاوه ICMP Echo است که بسته اصلی داخل آن قرار می‌گیرد.',
        'تنظیمات نسخه ۲ یک مجموعه بسته است: local-ipv4، peer-ipv4، send-replies، identifier، sequence-start، ttl و tos. هر کلید دیگری با خطای مهاجرت رد می‌شود.',
        'آدرس‌ها بین دو سمت معکوس می‌شود: هر نود local-ipv4 خودش و peer-ipv4 طرف مقابل را دارد.',
        'نود یک حلقه ۱۰۲۴تایی از درخواست‌های بی‌پاسخ و یک حلقه ۱۰۲۴تایی بازپخش نگه می‌دارد؛ بسته تکراری فقط یک‌بار تحویل داده می‌شود.',
        'بیشترین بسته حامل ۱۵۰۰ بایت است و نود خودش fragment نمی‌کند؛ پس MTU مؤثر را در نظر بگیرید.',
      ],
      warnings: [
        'Ping نسخه ۱ و ۲ روی سیم سازگار نیستند؛ هر دو سمت باید هم‌زمان ارتقا دهند.',
        'هر تنظیم نسخه ۱ باعث خطای راه‌اندازی می‌شود. پنل این کانفیگ را پیش از تولید بررسی می‌کند.',
        'RawSocket به root یا CAP_NET_ADMIN نیاز دارد: iptables و NFQUEUE را تنظیم می‌کند.',
        'پکت‌های capture‌شده از استک شبکه میزبان حذف می‌شوند؛ فیلتر اشتباه می‌تواند ترافیک واقعی سرور را قطع کند.',
        'ساختار درست ICMP به‌تنهایی ترافیک پرنرخ را نامرئی نمی‌کند؛ زمان‌بندی، حجم و ویژگی محموله هم اثر دارند.',
        'اگر send-replies روشن باشد ترافیک دوطرفه می‌شود و احتمال شناسایی بالا می‌رود؛ در عوض تأخیر کمتر می‌شود.',
      ],
    };
  },
};

module.exports = [tun2socks, pingTunnel];