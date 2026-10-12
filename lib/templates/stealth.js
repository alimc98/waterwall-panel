'use strict';

/**
 * IpManipulator's SNI tricks, plus the Disturber lab.
 *
 * Every trick here works by putting something *unexpected* in front of the real
 * ClientHello so that a DPI which latches onto the first one classifies the
 * connection wrongly. They differ in how they do that, and in how much they
 * perturb the connection.
 *
 * All of these are packet-level, so they need `RawSocket` and therefore root or
 * CAP_NET_ADMIN. They also need at least one trick enabled: IpManipulator
 * refuses to construct with an empty settings object.
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

/** Shared transport fields for every packet-level trick in this file. */
const packetFields = () => [
  { key: 'userPort', group: 'entry', label: 'User-facing port (Iran)', labelFa: 'پورت کاربران (ایران)', type: 'number', default: 443, min: 1, max: 65535, required: true },
  { key: 'iranTunName', group: 'tun', label: 'TUN name (Iran)', labelFa: 'نام TUN (ایران)', type: 'text', default: 'wtun1' },
  { key: 'iranTunIp', group: 'tun', label: 'TUN IPv4 (Iran)', labelFa: 'آدرس TUN (ایران)', type: 'text', default: '10.10.0.1/24' },
  { key: 'iranPeerTunIp', group: 'tun', label: 'Peer TUN IPv4', labelFa: 'آدرس TUN مقابل', type: 'text', default: '10.10.0.2' },
  { key: 'foreignTunName', group: 'tun', label: 'TUN name (foreign)', labelFa: 'نام TUN (خارج)', type: 'text', default: 'wtun1' },
  { key: 'foreignTunIp', group: 'tun', label: 'TUN IPv4 (foreign)', labelFa: 'آدرس TUN (خارج)', type: 'text', default: '10.10.0.1/24' },
  { key: 'xorKey', group: 'obfuscation', label: 'XOR key (0-255)', labelFa: 'کلید XOR', type: 'number', default: 90, min: 0, max: 255 },
  { key: 'obfSkip', group: 'obfuscation', label: 'Obfuscator skip', labelFa: 'حالت skip', type: 'select', default: 'transport', options: ['none', 'ipv4', 'transport'] },
  { key: 'deviceMtu', group: 'obfuscation', label: 'MTU', labelFa: 'MTU', type: 'number', default: 1400, min: 68, max: 65535 },
];

/**
 * Validate the decoy settings, because every one of these is a startup error
 * in WaterWall and the failure message names only the setting, not the bound
 * you crossed.
 */
function validateFirstSni(options) {
  const count = Number(options.decoyCount);
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new Error('تعداد نسخه‌های جعلی باید بین ۱ تا ۱۶ باشد.');
  }
  const decoy = String(options.decoyHost || '').trim();
  if (Buffer.byteLength(decoy, 'utf8') < 1 || Buffer.byteLength(decoy, 'utf8') > 65535) {
    throw new Error('نام میزبان نسخه جعلی باید بین ۱ تا ۶۵۵۳۵ بایت باشد.');
  }
  const replay = Number(options.decoyReplayDelayMs) || 0;
  const finalDelay = Number(options.decoyFinalDelayMs) || 0;
  if (replay < 0 || finalDelay < 0) {
    throw new Error('تأخیرها نمی‌توانند منفی باشند.');
  }
  // WaterWall rejects the config when the chained delay overflows uint32 ms.
  const total = (count - 1) * replay + finalDelay;
  if (total > 0xffffffff) {
    throw new Error('مجموع تأخیرها از محدوده uint32 میلی‌ثانیه بیشتر می‌شود و واتروال کانفیگ را رد می‌کند.');
  }

  const settings = {
    'first-sni': decoy,
    'first-sni-count': count,
    'first-sni-replay-delay': replay,
    'first-sni-final-delay': finalDelay,
  };
  // Omit the TTL key entirely to keep the original, which is different from
  // writing 0 — 0 is a real override, not "unset".
  if (options.decoyTtlEnabled) settings['first-sni-ttl'] = Number(options.decoyTtl) || 0;
  if (options.decoyRandomSequence) settings['first-sni-random-tcp-sequence'] = true;

  // Docs are explicit: configure at least one mechanism, otherwise the decoy
  // can be accepted as real in-window data.
  if (!options.decoyTtlEnabled && !options.decoyRandomSequence) {
    throw new Error(
      'حداقل یکی از «TTL نسخه جعلی» یا «sequence تصادفی» باید فعال باشد، وگرنه سرور مقصد می‌تواند نسخه جعلی را به‌عنوان داده واقعی بپذیرد.',
    );
  }
  return settings;
}

// ---------------------------------------------------------------------------
// 1. first-sni
// ---------------------------------------------------------------------------

/**
 *   Iran     TUN -> IpOverrider -> IpManipulator(first-sni) -> ObfuscatorClient -> RawSocket
 *   Foreign  TUN -> IpOverrider -> ObfuscatorServer -> RawSocket
 *
 * Decoy ClientHello copies carrying a different host name go out ahead of the
 * real one on the same TCP connection. The real ClientHello is never rewritten,
 * split or reordered — it still travels intact, exactly once, at its real
 * sequence number.
 *
 * Two independent mechanisms keep the decoy away from the destination:
 * a TTL low enough to expire in transit, or a random TCP sequence so it lands
 * outside the receive window. WaterWall does not pick one for you, and the docs
 * are clear that with neither the decoy may be delivered as valid in-window
 * data — which is why the panel refuses to build this without one.
 */
const firstSni = {
  id: 'first-sni',
  title: 'Decoy First ClientHello (first-sni)',
  titleFa: 'ClientHello جعلی اول (first-sni)',
  category: 'stealth',
  categoryFa: 'استتار',
  icon: '🎭',
  sides: ['iran', 'foreign'],
  minVersion: '1.46.96',
  summary:
    'IpManipulator sends decoy TLS ClientHello copies with a replaced host name ahead of the real one. DPI systems that latch onto the first ClientHello record the decoy name.',
  summaryFa:
    'چند نسخه جعلی از ClientHello با نام میزبان متفاوت، پیش از نسخه واقعی روی همان اتصال TCP فرستاده می‌شود. سامانه‌هایی که اولین ClientHello را ثبت می‌کنند، نام جعلی را به‌عنوان مقصد واقعی ثبت می‌کنند. خود ClientHello واقعی دست‌نخورده و فقط یک‌بار فرستاده می‌شود.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/IpManipulator',
  tags: ['dpi', 'sni', 'tls', 'decoy', 'clienthello', 'raw-socket'],
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی روی TUN دوم سرور خارج تحویل می‌گیرد.',
  fields: [
    ...packetFields(),
    {
      key: 'decoyHost',
      group: 'decoy',
      label: 'Decoy host name',
      labelFa: 'نام میزبان جعلی',
      type: 'text',
      default: 'www.bing.com',
      required: true,
      help: 'فقط اولین host_name در نسخه جعلی بازنویسی می‌شود. یک دامنه واقعی و پرترافیک انتخاب کنید.',
    },
    {
      key: 'decoyCount',
      group: 'decoy',
      label: 'Decoy copies',
      labelFa: 'تعداد نسخه‌های جعلی',
      type: 'number',
      default: 2,
      min: 1,
      max: 16,
      required: true,
    },
    { key: 'decoyReplayDelayMs', group: 'decoy', label: 'Replay delay (ms)', labelFa: 'فاصله بین نسخه‌ها', type: 'number', default: 0, min: 0 },
    { key: 'decoyFinalDelayMs', group: 'decoy', label: 'Final delay (ms)', labelFa: 'تأخیر قبل از نسخه واقعی', type: 'number', default: 10, min: 0 },
    {
      key: 'decoyTtlEnabled',
      group: 'decoy',
      label: 'Override the decoy TTL',
      labelFa: 'تغییر TTL نسخه جعلی',
      type: 'boolean',
      default: true,
      help: 'اگر خاموش باشد کلید TTL اصلاً نوشته نمی‌شود و TTL اصلی حفظ می‌شود. توجه: نوشتن ۰ یک بازنویسی واقعی است، نه «بدون تنظیم».',
    },
    {
      key: 'decoyTtl',
      group: 'decoy',
      label: 'Decoy TTL',
      labelFa: 'TTL نسخه جعلی',
      type: 'number',
      default: 3,
      min: 0,
      max: 255,
      when: { decoyTtlEnabled: [true] },
      help: 'مقدار را روی مسیر خودتان اندازه بگیرید: به‌قدری کم که بسته در مسیر منقضی شود ولی به مقصد نرسد.',
    },
    {
      key: 'decoyRandomSequence',
      group: 'decoy',
      label: 'Random TCP sequence for decoys',
      labelFa: 'sequence تصادفی برای نسخه جعلی',
      type: 'boolean',
      default: true,
      help: 'شماره sequence تازه و تصادفی به هر نسخه می‌دهد تا بیرون از پنجره دریافت بیفتد.',
    },
    ...destFields(),
    ...secretFields,
    ...coreFields().map((f) => (f.key === '_core.mtu' ? { ...f, default: 1400 } : f)),
  ],

  build({ options }) {
    const userPort = Number(options.userPort) || 443;
    const ipSettings = validateFirstSni(options);
    const obf = { method: 'xor', xor_key: Number(options.xorKey) || 0, skip: options.obfSkip || 'transport' };
    const tunBase = String(options.iranTunIp).split('/')[0];
    const foreignBase = String(options.foreignTunIp).split('/')[0];

    const iranNodes = [
      node('users_inbound', 'TcpListener', { address: '0.0.0.0', port: userPort, nodelay: true }, 'tcp-out'),
      node('tcp-out', 'TcpConnector', { address: options.iranPeerTunIp, port: userPort, nodelay: true }),
      node('my tun', 'TunDevice', { 'device-name': options.iranTunName, 'device-ip': options.iranTunIp }, 'ipovsrc'),
      node(
        'ipovsrc',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: options.iranHost }, 'dest-ip': { ipv4: options.foreignHost } },
          down: { 'source-ip': { ipv4: options.iranPeerTunIp }, 'dest-ip': { ipv4: tunBase } },
        },
        'ip-manipulator',
      ),
      node('ip-manipulator', 'IpManipulator', ipSettings, 'obfuscator-c'),
      node('obfuscator-c', 'ObfuscatorClient', obf, 'rd'),
      node('rd', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': options.foreignHost, 'bypass-conntrack': true }),
    ];

    const foreignNodes = [
      node('my tun2', 'TunDevice', { 'device-name': options.foreignTunName, 'device-ip': options.foreignTunIp }, 'ipcorrect'),
      node(
        'ipcorrect',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: options.foreignHost }, 'dest-ip': { ipv4: options.iranHost } },
          down: { 'source-ip': { ipv4: options.iranPeerTunIp }, 'dest-ip': { ipv4: foreignBase } },
        },
        'obfuscator-s',
      ),
      node('obfuscator-s', 'ObfuscatorServer', obf, 'rdin'),
      node('rdin', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': options.iranHost, 'bypass-conntrack': true }),
    ];

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'server', mtu: Number(options.deviceMtu) || 1400 }),
        files: { 'configs/first-sni.json': j(chainConfig('first-sni-iran', iranNodes), options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server', mtu: Number(options.deviceMtu) || 1400 }),
        files: { 'configs/first-sni.json': j(chainConfig('first-sni-foreign', foreignNodes), options) },
      },
      client: {
        links: [{ label: 'نقطه ورود کاربران (ایران)', url: `${options.iranHost}:${userPort}` }],
        instructions: [`کاربران به ${options.iranHost}:${userPort} وصل می‌شوند.`],
      },
      notes: [
        'اولین ClientHello واقعی بازنویسی، تکه‌تکه یا جابه‌جا نمی‌شود؛ کامل و دقیقاً یک‌بار روی sequence واقعی خودش فرستاده می‌شود.',
        `نام «${options.decoyHost}» فقط در اولین host_name نسخه‌های جعلی نوشته می‌شود.`,
        `تعداد نسخه جعلی: ${options.decoyCount}، فاصله: ${options.decoyReplayDelayMs} میلی‌ثانیه، تأخیر نهایی: ${options.decoyFinalDelayMs} میلی‌ثانیه.`,
        'این تکنیک فقط روی مسیر آپ جریان دارد و ترافیک پایین‌دست را دست نمی‌زند.',
      ],
      warnings: [
        'RawSocket به root یا CAP_NET_ADMIN نیاز دارد: iptables و NFQUEUE را تنظیم می‌کند.',
        'پکت‌های capture‌شده از استک شبکه میزبان حذف می‌شوند؛ فیلتر اشتباه می‌تواند ترافیک واقعی سرور را قطع کند.',
        options.decoyTtlEnabled && options.decoyRandomSequence
          ? 'هر دو سازوکار حذف نسخه جعلی فعال است؛ TTL کم و sequence تصادفی با هم معمولاً مطمئن‌تر از هرکدام به‌تنهایی است.'
          : 'فقط یکی از دو سازوکار حذف فعال است. اگر هیچ‌کدام نباشد، سرور مقصد ممکن است نسخه جعلی را به‌عنوان داده درون‌پنجره بپذیرد.',
        'مقدار TTL وابسته به مسیر است و باید روی همان مسیر اندازه‌گیری شود؛ عدد پیش‌فرض فقط یک حدس است.',
        'این تکنیک روی کانفیگ داخلی TLS پیاده می‌شود، نه روی اتصال کاربر به سرور ایران.',
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// 2. sni-blender + port ghost + packet duplicate
// ---------------------------------------------------------------------------

/**
 * A different family of trick: instead of adding a decoy, this reshapes and
 * hides the real packet.
 *
 *  - `sni-blender` fragments and shuffles the ClientHello packets, so a
 *    reassembling inspector has to put them back in order before it can read
 *    the SNI.
 *  - `source-port-ghost` / `dest-port-ghost` carry the original ports in the
 *    packet tail while the live transport uses rewritten ones, so port-based
 *    classification reads the wrong number.
 *  - `packet-duplicate` sends extra copies of the final packet.
 *
 * Unlike first-sni these need no decoy to be kept away from the destination,
 * but they do perturb the stream, so they cost a little throughput.
 */
const sniBlender = {
  id: 'sni-blender',
  title: 'SNI Blender + port ghost',
  titleFa: 'مخلوط‌کننده SNI + پورت شبح',
  category: 'stealth',
  categoryFa: 'استتار',
  icon: '🌀',
  sides: ['iran', 'foreign'],
  minVersion: '1.46.96',
  summary:
    'IpManipulator fragments and shuffles TLS ClientHello packets and hides the real ports in the packet tail, so reassembly-based DPI cannot read the SNI or the port.',
  summaryFa:
    'بسته‌های ClientHello تکه‌تکه و درهم‌آمیخته می‌شوند و پورت‌های واقعی در انتهای پکت پنهان می‌شوند، در حالی که پورت زنده روی سیم بازنویسی شده است. سامانه‌ای که بر پایه بازسازی و پورت تصمیم می‌گیرد، هر دو را اشتباه می‌خواند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/IpManipulator',
  tags: ['dpi', 'sni', 'reassembly', 'port-ghost', 'packet', 'raw-socket'],
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی روی TUN دوم سرور خارج تحویل می‌گیرد.',
  fields: [
    ...packetFields(),
    {
      key: 'blenderPackets',
      group: 'blender',
      label: 'ClientHello packets to fragment',
      labelFa: 'تعداد بسته‌های ClientHello برای تکه‌تکه شدن',
      type: 'number',
      default: 4,
      min: 1,
      max: 255,
      help: 'هرچه بیشتر، بازسازی برای ناظر سخت‌تر و تأخیر بیشتر.',
    },
    { key: 'ghostSourcePort', group: 'ghost', label: 'Hide the source port', labelFa: 'پنهان کردن پورت مبدأ', type: 'boolean', default: true },
    { key: 'ghostDestPort', group: 'ghost', label: 'Hide the destination port', labelFa: 'پنهان کردن پورت مقصد', type: 'boolean', default: true },
    {
      key: 'packetDuplicate',
      group: 'ghost',
      label: 'Duplicate the final packet N times',
      labelFa: 'تکثیر پکت آخر',
      type: 'number',
      default: 0,
      min: 0,
      max: 8,
      help: 'نسخه‌های اضافه پیش از نسخه اصلی فرستاده می‌شوند.',
    },
    ...destFields(),
    ...secretFields,
    ...coreFields().map((f) => (f.key === '_core.mtu' ? { ...f, default: 1400 } : f)),
  ],

  build({ options }) {
    const userPort = Number(options.userPort) || 443;
    const obf = { method: 'xor', xor_key: Number(options.xorKey) || 0, skip: options.obfSkip || 'transport' };
    const tunBase = String(options.iranTunIp).split('/')[0];
    const foreignBase = String(options.foreignTunIp).split('/')[0];

    // WaterWall refuses to construct IpManipulator with no trick enabled.
    const ipSettings = {
      'sni-blender': true,
      'sni-blender-packets': Number(options.blenderPackets) || 4,
      ...(options.ghostSourcePort ? { 'source-port-ghost': true } : {}),
      ...(options.ghostDestPort ? { 'dest-port-ghost': true } : {}),
      ...(Number(options.packetDuplicate) > 0 ? { 'packet-duplicate': Number(options.packetDuplicate) } : {}),
    };
    if (Object.keys(ipSettings).length < 2) {
      throw new Error('حداقل یک ترفند باید فعال باشد؛ IpManipulator بدون هیچ ترفندی ساخته نمی‌شود.');
    }

    const iranNodes = [
      node('users_inbound', 'TcpListener', { address: '0.0.0.0', port: userPort, nodelay: true }, 'tcp-out'),
      node('tcp-out', 'TcpConnector', { address: options.iranPeerTunIp, port: userPort, nodelay: true }),
      node('my tun', 'TunDevice', { 'device-name': options.iranTunName, 'device-ip': options.iranTunIp }, 'ipovsrc'),
      node(
        'ipovsrc',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: options.iranHost }, 'dest-ip': { ipv4: options.foreignHost } },
          down: { 'source-ip': { ipv4: options.iranPeerTunIp }, 'dest-ip': { ipv4: tunBase } },
        },
        'ip-manipulator',
      ),
      node('ip-manipulator', 'IpManipulator', ipSettings, 'obfuscator-c'),
      node('obfuscator-c', 'ObfuscatorClient', obf, 'rd'),
      node('rd', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': options.foreignHost, 'bypass-conntrack': true }),
    ];

    const foreignNodes = [
      node('my tun2', 'TunDevice', { 'device-name': options.foreignTunName, 'device-ip': options.foreignTunIp }, 'ipcorrect'),
      node(
        'ipcorrect',
        'IpOverrider',
        {
          up: { 'source-ip': { ipv4: options.foreignHost }, 'dest-ip': { ipv4: options.iranHost } },
          down: { 'source-ip': { ipv4: options.iranPeerTunIp }, 'dest-ip': { ipv4: foreignBase } },
        },
        'obfuscator-s',
      ),
      node('obfuscator-s', 'ObfuscatorServer', obf, 'rdin'),
      node('rdin', 'RawSocket', { 'capture-filter-mode': 'source-ip', 'capture-ip': options.iranHost, 'bypass-conntrack': true }),
    ];

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'server', mtu: Number(options.deviceMtu) || 1400 }),
        files: { 'configs/sni-blender.json': j(chainConfig('sni-blender-iran', iranNodes), options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server', mtu: Number(options.deviceMtu) || 1400 }),
        files: { 'configs/sni-blender.json': j(chainConfig('sni-blender-foreign', foreignNodes), options) },
      },
      client: {
        links: [{ label: 'نقطه ورود کاربران (ایران)', url: `${options.iranHost}:${userPort}` }],
        instructions: [`کاربران به ${options.iranHost}:${userPort} وصل می‌شوند.`],
      },
      notes: [
        `sni-blender بسته‌های IPv4/TCP مربوط به ClientHello را به ${options.blenderPackets} بخش می‌شکند و ترتیبشان را به هم می‌ریزد.`,
        options.ghostSourcePort || options.ghostDestPort
          ? 'پورت‌های اصلی در انتهای پکت حمل می‌شوند و در مسیر برگشت به حالت اول برمی‌گردند.'
          : 'هیچ پورتی پنهان نشده است؛ فقط تکه‌تکه کردن اعمال می‌شود.',
        Number(options.packetDuplicate) > 0
          ? `آخرین پکت ${options.packetDuplicate} بار پیش از نسخه اصلی تکثیر می‌شود.`
          : 'تکثیر پکت غیرفعال است.',
      ],
      warnings: [
        'RawSocket به root یا CAP_NET_ADMIN نیاز دارد: iptables و NFQUEUE را تنظیم می‌کند.',
        'پکت‌های capture‌شده از استک شبکه میزبان حذف می‌شوند؛ فیلتر اشتباه می‌تواند ترافیک واقعی سرور را قطع کند.',
        'هر دو سمت باید تنظیمات یکسان داشته باشند؛ پورت‌های پنهان در مسیر برگشت بازیابی می‌شوند.',
        'تکه‌تکه کردن جریان را کمی کند و حافظه بیشتری مصرف می‌کند؛ با تست سرعت مقایسه کنید.',
        'اگر هیچ ترفندی فعال نباشد واتروال اصلاً نود را نمی‌سازد.',
        'تکنیک بسیار وابسته به مسیر است؛ آنچه روی یک مسیر کار می‌کند ممکن است جای دیگر نادیده گرفته شود.',
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// 3. disturber lab
// ---------------------------------------------------------------------------

/**
 * Not a tunnel you deploy for users: a laboratory. `Disturber` injects
 * artificial loss, delay, corruption and duplication with per-event
 * probabilities, so you can answer "how bad does this get when the link drops
 * 3% of packets?" before you find out from your users.
 *
 * Both directions default differently on purpose: upstream disturbance is on,
 * downstream is off. A stream node only tolerates a bit of loss in one
 * direction before it stalls.
 */
const disturberLab = {
  id: 'disturber-lab',
  title: 'Link Lab (artificial loss/delay)',
  titleFa: 'آزمایشگاه لینک (تلفی و تأخیر مصنوعی)',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '🧪',
  sides: ['iran', 'foreign'],
  summary:
    'Disturber injects configurable loss, delay, corruption and duplication with per-event probabilities. A lab, not a production tunnel.',
  summaryFa:
    'نود Disturber با احتمال مشخص تلفی، تأخیر، خرابی و تکثیر مصنوعی تزریق می‌کند تا قبل از استقرار نهایی بفهمید کدام بخش تونل با چه میزان اختلال می‌شکند. این یک ابزار آزمایشی است، نه تونلی برای کاربران.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/Disturber',
  tags: ['testing', 'disturber', 'loss', 'latency', 'lab', 'diagnostics'],
  clientHint: 'برای تست؛ روی مسیر واقعی بین دو سرور قرار می‌گیرد.',
  fields: [
    { key: 'listenPort', group: 'entry', label: 'Entry port (Iran)', labelFa: 'پورت ورودی (ایران)', type: 'number', default: 443, min: 1, max: 65535, required: true },
    { key: 'linkPort', group: 'entry', label: 'Link port (Iran)', labelFa: 'پورت لینک (ایران)', type: 'number', default: 2053, min: 1, max: 65535, required: true },
    { key: 'lossPercent', group: 'disturb', label: 'Payload loss (%)', labelFa: 'تلفی محموله', type: 'number', default: 2, min: 0, max: 100 },
    { key: 'corruptPercent', group: 'disturb', label: 'Payload corruption (%)', labelFa: 'خرابی محموله', type: 'number', default: 0, min: 0, max: 100 },
    { key: 'duplicatePercent', group: 'disturb', label: 'Payload duplication (%)', labelFa: 'تکثیر محموله', type: 'number', default: 0, min: 0, max: 100 },
    { key: 'middleClosePercent', group: 'disturb', label: 'Close mid-payload (%)', labelFa: 'بستن حین محموله', type: 'number', default: 0, min: 0, max: 100 },
    { key: 'instantClosePercent', group: 'disturb', label: 'Close on init (%)', labelFa: 'بستن هنگام شروع', type: 'number', default: 0, min: 0, max: 100 },
    { key: 'delayMs', group: 'disturb', label: 'Added delay (ms)', labelFa: 'تأخیر افزوده', type: 'number', default: 0, min: 0, max: 60000 },
    { key: 'disturbDownstream', group: 'disturb', label: 'Disturb downstream too', labelFa: 'آزمایش مسیر برگشت هم باشد', type: 'boolean', default: false },
    ...destFields(),
    ...secretFields,
    ...coreFields(),
  ],

  build({ options }) {
    const listenPort = Number(options.listenPort) || 443;
    const linkPort = Number(options.linkPort) || 2053;
    const pct = (v) => Math.max(0, Math.min(100, Number(v) || 0));

    const dist = {
      'disturb-upstream': true,
      'disturb-downstream': options.disturbDownstream !== false,
      chance_instant_close: pct(options.instantClosePercent),
      chance_middle_close: pct(options.middleClosePercent),
      chance_payload_corruption: pct(options.corruptPercent),
      chance_payload_loss: pct(options.lossPercent),
      chance_payload_duplication: pct(options.duplicatePercent),
    };
    const delayMs = Number(options.delayMs) || 0;
    if (delayMs > 0) dist['delay-duration-ms'] = delayMs;

    const iranNodes = [
      node('users', 'TcpListener', { address: '0.0.0.0', port: listenPort, nodelay: true }, 'disturb'),
      node('disturb', 'Disturber', dist, 'crypt-c'),
      node('crypt-c', 'EncryptionClient', { password: options.password, salt: options.salt }, 'out'),
      node('out', 'TcpConnector', { address: options.foreignHost, port: linkPort, nodelay: true }),
    ];

    const foreignNodes = [
      node(
        'public',
        'TcpListener',
        { address: '0.0.0.0', port: linkPort, nodelay: true, whitelist: [`${options.iranHost}/32`] },
        'crypt-s',
      ),
      node('crypt-s', 'EncryptionServer', { password: options.password, salt: options.salt }, 'disturb'),
      node('disturb', 'Disturber', dist, 'out'),
      node('out', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort), nodelay: true }),
    ];

    const totalLoss = pct(options.lossPercent) + pct(options.corruptPercent);

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: { 'configs/disturber-lab.json': j(chainConfig('disturber-lab-iran', iranNodes), options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: { 'configs/disturber-lab.json': j(chainConfig('disturber-lab-foreign', foreignNodes), options) },
      },
      client: {
        links: [{ label: 'نقطه ورود (ایران)', url: `${options.iranHost}:${listenPort}` }],
        instructions: [
          `کاربران به ${options.iranHost}:${listenPort} وصل می‌شوند.`,
          'برای اندازه‌گیری، تست سرعت را قبل و بعد از فعال کردن این تونل اجرا کنید و تفاوت را ببینید.',
        ],
      },
      notes: [
        'پیش‌فرض واتروال: اختلال آپ فعال و اختلال پایین‌دست خاموش است. یک نود جریانی فقط مقدار کمی تلفی را در یک جهت تحمل می‌کند.',
        `تلفی روی آپ ${pct(options.lossPercent)}٪ و خرابی ${pct(options.corruptPercent)}٪.`,
        options.disturbDownstream
          ? 'اختلال مسیر برگشت هم فعال است، پس رفت و برگشت هر دو تحت تأثیر قرار می‌گیرند.'
          : 'مسیر برگشت دست‌نخورده است؛ فقط آپ تحت تأثیر قرار می‌گیرد.',
      ],
      warnings: [
        '⚠️ این یک تونل عملیاتی نیست. هر درصد تلفی که تنظیم کنید عمداً به اتصال‌ها آسیب می‌زند.',
        'برای تست روی ترافیک واقعی کاربران استفاده نکنید؛ فقط در محیط آزمایشی یا ساعات خلوت.',
        totalLoss > 10
          ? `مجموع تلفی و خرابی ${totalLoss}٪ روی یک اتصال TCP تقریباً همیشه به گیرکردن یا ریست می‌انجامد؛ این عدد فقط برای سنجش رفتار در تلفی شدید مفید است.`
          : '',
        'درصدها احتمال مستقل هر رویداد هستند، نه تضمین؛ نتیجه بین اجراها فرق می‌کند.',
        'برای خروجی قابل مقایسه، چند بار اندازه بگیرید و میانه را مبنا بگذارید.',
      ].filter(Boolean),
    };
  },
};

module.exports = [firstSni, sniBlender, disturberLab];