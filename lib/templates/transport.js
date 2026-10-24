'use strict';

const { CERT_PATH, KEY_PATH } = require('../certs');

/**
 * Two transports that solve specific problems rather than being generic
 * tunnels:
 *
 *  - tcpOverUdp runs TCP inside UDP with optional Reed-Solomon FEC. Useful when
 *    the path is lossy for TCP but fine for UDP, because KCP retransmits
 *    aggressively and the FEC shards can repair a burst without waiting for a
 *    retransmission round-trip.
 *  - headerProxy attaches connection metadata to the first payload, either as
 *    the PROXY protocol (so a real nginx or HAProxy on the exit can log the
 *    user's real IP) or as WaterWall's 2-byte destination-port header.
 */

const {coreFields, coreOpts, destFields, listenPorts, node} = require('./common');
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
// 1. TCP over UDP with FEC
// ---------------------------------------------------------------------------

/**
 *   Iran     TcpListener -> TlsClient -> TcpOverUdpClient -> UdpConnector
 *   Foreign  UdpListener -> TcpOverUdpServer -> TlsServer -> TcpConnector
 *
 * The client node speaks KCP, so the payload is chunked, retransmitted and —
 * optionally — wrapped in Reed-Solomon parity shards. The interesting knob is
 * FEC: with enough parity shards, a lost burst is repaired locally instead of
 * after a retransmission timeout, which is what makes this viable on a lossy
 * path.
 *
 * The cost is overhead and latency. Overhead is roughly (data+parity)/data, so
 * 10+3 shards means about 30% more bytes on the wire.
 */
const tcpOverUdp = {
  id: 'tcp-over-udp',
  title: 'TCP over UDP (KCP + optional FEC)',
  titleFa: 'TCP روی UDP (KCP با FEC اختیاری)',
  category: 'resilience',
  categoryFa: 'پایداری',
  icon: '🛟',
  sides: ['iran', 'foreign'],
  listenPorts: listenPorts({
    iran: ['listenPort'],
    foreign: [],
    relay: [],
    pairs: [],
  }),
  minVersion: '1.46.96',
  summary:
    'TcpOverUdpClient / TcpOverUdpServer run TCP inside KCP datagrams, with optional Reed-Solomon forward error correction for lossy paths.',
  summaryFa:
    'ترافیک TCP داخل دیتاگرام KCP حمل می‌شود. KCP به‌جای الگوریتم‌های دوباره‌فرستی TCP، تهاجمی‌تر بازارسالی می‌کند و در صورت فعال بودن FEC، قطعات Reed-Solomon می‌توانند یک بریدگی تلفی را بدون انتظار برای بازارسالی ترمیم کنند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/TcpOverUdpClient',
  tags: ['udp', 'kcp', 'fec', 'loss', 'lossy-link', 'resilience'],
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ فقط لازم است UDP روی مسیر باز باشد.',
  fields: [
    { key: 'listenAddress', group: 'entry', label: 'Bind address (Iran)', labelFa: 'آدرس bind (ایران)', type: 'text', default: '0.0.0.0' },
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
    },
    {
      key: 'linkPort',
      group: 'entry',
      label: 'UDP link port',
      labelFa: 'پورت لینک UDP',
      type: 'number',
      default: 2053,
      min: 1,
      max: 65535,
      required: true,
      help: 'این پورت باید روی هر دو سرور از نوع UDP باز باشد.',
    },
    {
      key: 'fec',
      group: 'fec',
      label: 'Forward error correction',
      labelFa: 'اصلاح خطای رو به جلو',
      type: 'boolean',
      default: true,
    },
    {
      key: 'fecDataShards',
      group: 'fec',
      label: 'FEC data shards',
      labelFa: 'قطعه‌های داده FEC',
      type: 'number',
      default: 10,
      min: 1,
      max: 255,
      when: { fec: [true] },
    },
    {
      key: 'fecParityShards',
      group: 'fec',
      label: 'FEC parity shards',
      labelFa: 'قطعه‌های parity',
      type: 'number',
      default: 3,
      min: 1,
      max: 255,
      when: { fec: [true] },
      help: 'سقف تلفی قابل ترمیم در هر بلوک همین عدد است.',
    },
    {
      key: 'kcpIntervalMs',
      group: 'kcp',
      label: 'KCP update interval (ms)',
      labelFa: 'بازه به‌روزرسانی KCP',
      type: 'number',
      default: 10,
      min: 10,
      max: 5000,
    },
    { key: 'kcpResend', group: 'kcp', label: 'KCP fast-resend', labelFa: 'بازارسالی سریع KCP', type: 'number', default: 2, min: 0 },
    { key: 'kcpNodelay', group: 'kcp', label: 'KCP nodelay mode', labelFa: 'حالت nodelay', type: 'boolean', default: true },
    {
      key: 'kcpNoCongestionControl',
      group: 'kcp',
      label: 'Disable KCP congestion control',
      labelFa: 'غیرفعال کردن کنترل ازدحام KCP',
      type: 'boolean',
      default: false,
      help: 'روی مسیر با تأخیر زیاد سرعت را بالا می‌برد ولی می‌تواند باعث طوفان بازارسالی شود.',
    },
    { key: 'kcpSendWindow', group: 'kcp', label: 'KCP send window', labelFa: 'پنجره ارسال KCP', type: 'number', default: 8192, min: 1 },
    ...destFields(),
    ...secretFields,
    ...coreFields(),
  ],

  build({ options }) {
    const listenPort = Number(options.listenPort) || 443;
    const linkPort = Number(options.linkPort) || 2053;
    const fec = options.fec !== false;
    const dataShards = Math.max(1, Number(options.fecDataShards) || 10);
    const parityShards = Math.max(1, Number(options.fecParityShards) || 3);

    // WaterWall rejects shards that are not positive or that sum past 255.
    if (dataShards + parityShards > 255) {
      throw new Error(
        `مجموع قطعه‌های FEC (${dataShards}+${parityShards}=${dataShards + parityShards}) از حد ۲۵۵ بیشتر است و واتروال کانفیگ را رد می‌کند.`,
      );
    }

    const overUdp = {
      fec,
      ...(fec ? { 'fec-data-shards': dataShards, 'fec-parity-shards': parityShards } : {}),
      'kcp-nodelay': options.kcpNodelay !== false,
      'kcp-interval-ms': Number(options.kcpIntervalMs) || 10,
      'kcp-resend': Number(options.kcpResend) || 0,
      'kcp-no-congestion-control': options.kcpNoCongestionControl !== false,
      'kcp-send-window': Number(options.kcpSendWindow) || 8192,
    };

    const iranNodes = [
      node('users', 'TcpListener', { address: options.listenAddress, port: listenPort, nodelay: true }, 'tls-c'),
      node('tls-c', 'TlsClient', { sni: options.sni, verify: options.verify !== false }, 'over-udp'),
      node('over-udp', 'TcpOverUdpClient', overUdp, 'udp-out'),
      node('udp-out', 'UdpConnector', { address: options.foreignHost, port: linkPort }),
    ];

    const foreignNodes = [
      node('public', 'UdpListener', { address: '0.0.0.0', port: linkPort }, 'over-udp'),
      node('over-udp', 'TcpOverUdpServer', overUdp, 'tls-s'),
      node('tls-s', 'TlsServer', { 'cert-file': CERT_PATH, 'key-file': KEY_PATH, sni: options.sni }, 'out'),
      node('out', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort), nodelay: true }),
    ];

    const overhead = fec ? Math.round((parityShards / dataShards) * 100) : 0;

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: { 'configs/tcp-over-udp.json': j(chainConfig('tcp-over-udp-iran', iranNodes), options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: { 'configs/tcp-over-udp.json': j(chainConfig('tcp-over-udp-foreign', foreignNodes), options) },
      },
      client: {
        links: [{ label: 'نقطه ورود کاربران (ایران)', url: `${options.iranHost}:${listenPort}` }],
        instructions: [
          `کاربران به ${options.iranHost}:${listenPort} وصل می‌شوند.`,
          `پورت ${linkPort} باید در فایروال هر دو سرور از نوع UDP باز باشد.`,
        ],
      },
      notes: [
        fec
          ? `FEC فعال با ${dataShards} قطعه داده و ${parityShards} قطعه parity: حدود ${overhead}٪ بایت بیشتر روی سیم، در عوض تا ${parityShards} بسته گم‌شده در هر بلوک بدون بازارسالی ترمیم می‌شود.`
          : 'FEC خاموش است؛ همه بازیابی به بازارسالی KCP وابسته است.',
        `بازه به‌روزرسانی KCP ${options.kcpIntervalMs} میلی‌ثانیه و بازارسالی سریع ${options.kcpResend}.`,
        'این زنجیره TCP را داخل UDP می‌برد، پس فقط مسیر UDP لازم است.',
      ],
      warnings: [
        `افزوده نرخ داده حدود ${overhead}٪ است؛ FEC را فقط وقتی روشن کنید که مسیر واقعاً تلفی دارد.`,
        'UDP روی بسیاری از مسیرهای ایران اولویت پایین‌تری از TCP دارد؛ اگر تونل کند شد، ابتدا همین را تست کنید.',
        'غیرفعال کردن کنترل ازدحام KCP روی مسیر با تأخیر زیاد سرعت را بالا می‌برد ولی می‌تواند طوفان بازارسالی بسازد و لینک را بدتر کند.',
        `مجموع قطعه‌های FEC نباید از ۲۵۵ بیشتر شود؛ پنل این را قبل از تولید بررسی می‌کند.`,
        'پورت لینک باید UDP باز باشد؛ اگر فقط TCP باز کنید هیچ اتصالی برقرار نمی‌شود.',
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// 2. header / PROXY protocol
// ---------------------------------------------------------------------------

/**
 * `HeaderClient` prepends a one-time header to the *first* upstream payload and
 * is then transparent. `HeaderServer` consumes it and writes the result into
 * `dest_context->port` or `src_context`.
 *
 * The PROXY protocol mode is the reason this template exists: it lets the exit
 * hand traffic to a real nginx or HAProxy that already understands PROXY
 * protocol, so the backend logs the user's actual address instead of the
 * tunnel's.
 *
 * `frontend-ipv4` is required for PROXY mode and must be the address clients
 * actually connect to — a wrong value makes the backend log a wrong source.
 */
const headerProxy = {
  id: 'header-proxy',
  title: 'Header / PROXY protocol backend',
  titleFa: 'هدر / پروتکل PROXY برای بک‌اند',
  category: 'stream',
  categoryFa: 'جریان',
  icon: '🏷',
  sides: ['iran', 'foreign'],
  listenPorts: listenPorts({
    iran: ['listenPort'],
    foreign: ['linkPort'],
    relay: [],
    pairs: [],
  }),
  minVersion: '1.46.96',
  summary:
    'HeaderClient / HeaderServer attach a one-time header to the first payload: either HAProxy PROXY protocol v1/v2 or WaterWall’s 2-byte destination-port header.',
  summaryFa:
    'HeaderClient یک هدر یک‌باره به اولین محموله اضافه می‌کند و بعد شفاف می‌شود. HeaderServer آن را می‌خواند و در dest_context->port یا src_context می‌گذارد. حالت PROXY protocol باعث می‌شود nginx یا HAProxy روی سرور خارج IP واقعی کاربر را در لاگ ثبت کند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/HeaderClient',
  tags: ['proxy-protocol', 'nginx', 'header', 'source-ip', 'metadata'],
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی می‌تواند به یک nginx واقعی برسد.',
  fields: [
    { key: 'listenAddress', group: 'entry', label: 'Bind address (Iran)', labelFa: 'آدرس bind (ایران)', type: 'text', default: '0.0.0.0' },
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
    },
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
    {
      key: 'headerMode',
      group: 'header',
      label: 'Header format',
      labelFa: 'نوع هدر',
      type: 'select',
      default: 'proxy-protocol-v2',
      options: ['proxy-protocol-v2', 'proxy-protocol-v1', 'proxy-protocol', 'port-header', 'source-port'],
      help: 'proxy-protocol را nginx یا HAProxy با پشتیبانی PROXY protocol می‌فهمد؛ port-header فقط پورت مقصد را منتقل می‌کند.',
    },
    {
      key: 'frontendIpv4',
      group: 'header',
      label: 'Frontend IPv4 seen by clients',
      labelFa: 'آدرس IPv4 که کاربران می‌بینند',
      type: 'text',
      default: '1.1.1.1',
      required: true,
      help: 'برای حالت PROXY اجباری است: بک‌اند IP واقعی کاربر را از این آدرس می‌خواند، پس مقدار اشتباه باعث لاگ اشتباه می‌شود.',
    },
    {
      key: 'portHeaderValue',
      group: 'header',
      label: 'Port header value',
      labelFa: 'مقدار هدر پورت',
      type: 'number',
      default: 443,
      min: 1,
      max: 65535,
      when: { headerMode: ['port-header'] },
      help: 'مقدار ثابتی که به‌عنوان پورت مقصد منتقل می‌شود. خارج از بازه ۱ تا ۶۵۵۳۵ کانفیگ رد می‌شود.',
    },
    ...destFields(),
    ...secretFields,
    ...coreFields(),
  ],

  build({ options }) {
    const listenPort = Number(options.listenPort) || 443;
    const linkPort = Number(options.linkPort) || 2053;
    const mode = options.headerMode || 'proxy-protocol-v2';
    const isProxy = mode.startsWith('proxy-protocol');

    const frontend = String(options.frontendIpv4 || '').trim();
    if (isProxy && !/^\d{1,3}(\.\d{1,3}){3}$/.test(frontend)) {
      throw new Error('برای حالت PROXY protocol یک آدرس IPv4 معتبر برای «آدرس IPv4 که کاربران می‌بینند» لازم است.');
    }

    // WaterWall rejects a missing/unknown `data` at startup, so build it from
    // the mode rather than passing the mode through.
    const headerClient =
      mode === 'port-header'
        ? { data: Math.max(1, Math.min(65535, Number(options.portHeaderValue) || 443)) }
        : mode === 'source-port'
          ? { data: 'src_context->port' }
          : { data: mode, 'frontend-ipv4': frontend };

    const iranNodes = [
      node('users', 'TcpListener', { address: options.listenAddress, port: listenPort, nodelay: true }, 'crypt-c'),
      node('crypt-c', 'EncryptionClient', { password: options.password, salt: options.salt }, 'hdr'),
      node('hdr', 'HeaderClient', headerClient, 'out'),
      node('out', 'TcpConnector', { address: options.foreignHost, port: linkPort, nodelay: true }),
    ];

    // HeaderServer requires an explicit `override` and refuses to start
    // without one:
    //   FATAL HeaderServer: settings.override is required and must be a port
    //   number, "dest_context->port", or "proxy-protocol->source-fields"
    // The two header flavours the client side can send map onto exactly two of
    // those modes, so the choice is derived rather than asked for. The
    // WaterWall 2-byte header always lands in dest_context->port; only the
    // PROXY protocol carries source fields.
    const override = isProxy ? 'proxy-protocol->source-fields' : 'dest_context->port';

    const foreignNodes = [
      node(
        'public',
        'TcpListener',
        { address: '0.0.0.0', port: linkPort, nodelay: true, whitelist: [`${options.iranHost}/32`] },
        'hdr-s',
      ),
      // The header sits *outside* the cipher: HeaderClient prepends it to the
      // stream its previous node already encrypted, so the wire is
      // [header][ciphertext] and the receiver must read the header first.
      // Decrypting from byte 0 instead feeds the header to the cipher as if it
      // were key material — the header never appears, and the line stalls with
      // no error on either side and no data in either direction.
      node('hdr-s', 'HeaderServer', { override }, 'crypt-s'),
      node('crypt-s', 'EncryptionServer', { password: options.password, salt: options.salt }, 'out'),
      node('out', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort), nodelay: true }),
    ];

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: { 'configs/header-proxy.json': j(chainConfig('header-proxy-iran', iranNodes), options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: { 'configs/header-proxy.json': j(chainConfig('header-proxy-foreign', foreignNodes), options) },
      },
      client: {
        links: [{ label: 'نقطه ورود کاربران (ایران)', url: `${options.iranHost}:${listenPort}` }],
        instructions: [
          `کاربران به ${options.iranHost}:${listenPort} وصل می‌شوند.`,
          isProxy
            ? `روی سرور خارج، سرویس مقصد باید PROXY protocol را بفهمد. برای nginx گزینه proxy_protocol و برای HAProxy گزینه accept-proxy نوشته می‌شود.`
            : `بک‌اند پورت ${options.portHeaderValue || 443} را از هدر می‌خواند.`,
        ],
      },
      notes: [
        isProxy
          ? `هدر PROXY protocol ${mode === 'proxy-protocol' ? 'نسخه ۲' : 'نسخه ۱'} فقط روی اولین محموله آپ اضافه می‌شود و بعد نود شفاف است.`
          : mode === 'source-port'
            ? 'پورت مبدأ از src_context->port به‌صورت یک هدر ۲ بایتی منتقل می‌شود.'
            : `پورت مقصد به‌صورت ثابت (${options.portHeaderValue || 443}) در یک هدر ۲ بایتی منتقل می‌شود.`,
        'HeaderServer حتماً به کلید override نیاز دارد و بدون آن هسته بالا نمی‌آید؛ مقدار آن از حالت انتخابی ساخته می‌شود.',
        'HeaderServer بعد از خواندن هدر در جدول زنجیره شفاف می‌شود و بقیه جریان را دست‌نخورده رد می‌کند.',
        isProxy
          ? `آدرس frontend باید ${frontend} باشد؛ اگر کاربران از آدرس دیگری وصل شوند، بک‌اند IP اشتباهی در لاگ ثبت می‌کند.`
          : '',
      ].filter(Boolean),
      warnings: [
        isProxy
          ? 'بک‌اند حتماً باید PROXY protocol را پشتیبانی کند؛ اگر پشتیبانی نکند، هدر اولین بایت به‌عنوان داده تفسیر می‌شود و اتصال خراب می‌گردد.'
          : 'در حالت port-header فقط پورت منتقل می‌شود، نه IP مبدأ؛ برای دیدن IP واقعی کاربر باید از حالت PROXY protocol استفاده کنید.',
        'HeaderClient باید یک نود قبلی در زنجیره داشته باشد؛ سر یا انتهای زنجیره نیست.',
        'در حالت PROXY فقط IPv4 پشتیبانی می‌شود.',
        'آدرس frontend اگر اشتباه باشد، لاگ بک‌اند IP نادرست نشان می‌دهد و هیچ خطایی هم نمی‌دهد؛ آن را با آدرس واقعی کاربران تنظیم کنید.',
      ],
    };
  },
};

module.exports = [tcpOverUdp, headerProxy];