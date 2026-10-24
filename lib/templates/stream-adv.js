'use strict';

const { CERT_PATH, KEY_PATH } = require('../certs');

/**
 * Stream-level transport and shaping templates.
 *
 * These three all live in the same place: they sit between a user-facing
 * listener and the node that actually talks to the foreign server, and none of
 * them need a raw socket or root. That is what makes them easy to deploy
 * compared to the packet-level techniques in bitswap.js and protoswap.js.
 *
 *  - halfDuplex      Two TCP lines per user connection: one for upload, one for
 *                    download. A slow return path stops poisoning the send path.
 *  - streamFragmenter Shapes the TLS ClientHello into valid records with
 *                    configurable delays. Replaces the older "fake first
 *                    ClientHello" tricks without needing IpManipulator.
 *  - connectionFisher Races several connections to the same endpoint and keeps
 *                    the first one that proves it reached a real peer.
 */

const {coreFields, coreOpts, destFields, listenPorts, node} = require('./common');
const { chainConfig, emitConfig } = require('../generator');

const emit = (config, options) => emitConfig(config, { useVariables: options.useVariables !== false });

const j = (config, options) => emit(config, options);

/**
 * Credentials for the inner protector. `auto:` makes the panel generate the
 * value once and persist it, so a rebuild reuses the same secret on both sides.
 *
 * `when` keeps them out of the form when the protector is off, so nobody
 * fills in a password that is never used.
 */
const secretFields = [
  {
    key: 'sni',
    group: 'secret',
    label: 'SNI / server name',
    labelFa: 'SNI / نام سرور',
    type: 'text',
    default: 'example.com',
    help: 'TlsClient.settings.sni — باید با گواهی سرور خارج بخواند.',
  },
  {
    key: 'verify',
    group: 'secret',
    label: 'Verify certificate',
    labelFa: 'بررسی گواهی',
    type: 'boolean',
    default: true,
    help: 'در محیط واقعی روشن بماند؛ فقط برای گواهی خودامضا در حال تست خاموش کنید.',
  },
  {
    key: 'password',
    group: 'secret',
    label: 'Shared password (AEAD)',
    labelFa: 'رمز مشترک (AEAD)',
    type: 'password',
    default: 'auto:password',
    required: true,
    help: 'پنل یک‌بار تولید و ذخیره می‌کند تا هر دو سرور همیشه یکسان بمانند.',
  },
  { key: 'salt', group: 'secret', label: 'Salt', labelFa: 'Salt', type: 'text', default: 'ww-panel' },
];

function parseCuts(raw) {
  // Accept "250,2,50 300,5,40" as well as a real array of triples, because the
  // field is a free-text list in the UI and hand-edited values are common.
  const out = [];
  const push = (entry) => {
    const parts = Array.isArray(entry)
      ? entry
      : String(entry)
          .split(/[,\s]+/)
          .filter(Boolean)
          .map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return;
    const [offset, delayMs, chance] = parts;
    // WaterWall validates all of this at construction and refuses to start.
    if (offset < 1 || delayMs < 0 || chance < 0 || chance > 100) return;
    out.push([offset, delayMs, chance]);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else
    String(raw || '')
      .split(/[;\n]+/)
      .filter((s) => s.trim())
      .forEach(push);
  // Sort so unordered input still produces the valid ascending order. Duplicates
  // are deliberately left in: two cuts at the same offset mean two different
  // intentions, and silently keeping one would throw away what the user asked
  // for. build() rejects them.
  return out.sort((a, b) => a[0] - b[0]).slice(0, 64);
}

// ---------------------------------------------------------------------------
// 1. HalfDuplex
// ---------------------------------------------------------------------------

/**
 * `HalfDuplexClient` opens *two* transport lines toward a single `next` node:
 * an upload line and a download line, distinguished by a 17-byte intro that
 * carries a random pair id. `HalfDuplexServer` buffers whichever halves arrive
 * first, pairs them, and then presents one normal line to the rest of its
 * chain — so nothing downstream needs to know the transport was split.
 *
 * The practical effect is that upload and download no longer share one TCP
 * connection's congestion window and per-connection shaping. On a link where
 * the return direction is throttled but the forward direction is not, users
 * keep their send speed.
 *
 * Worth being precise about: the pair id is routing metadata, not
 * authentication. Both lines must still be protected by whatever security node
 * you place after the client, or an attacker who reaches the port can inject
 * into the download half.
 */
const halfDuplex = {
  id: 'half-duplex',
  title: 'Half Duplex (split upload/download)',
  titleFa: 'نیمه‌دوطرفه (جدا کردن آپلود و دانلود)',
  category: 'resilience',
  categoryFa: 'پایداری',
  icon: '🔀',
  sides: ['iran', 'foreign'],
  listenPorts: listenPorts({
    iran: ['listenPort'],
    foreign: ['linkPort'],
    relay: [],
    pairs: [],
  }),
  minVersion: '1.46.96',
  summary:
    'HalfDuplexClient / HalfDuplexServer. Every user connection becomes two TCP lines — one for upload, one for download — so a throttled return path stops limiting the send path.',
  summaryFa:
    'برای هر اتصال کاربر دو خط TCP جدا باز می‌شود: یکی برای آپلود و یکی برای دانلود. اگر مسیر برگشت روی اینترنت کند یا محدود باشد، دیگر سرعت ارسال کاربر را خراب نمی‌کند. سمت خارج دو نیمه را با هم جفت می‌کند و از آن به بعد یک اتصال معمولی به ادامه زنجیره می‌بیند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/HalfDuplexClient',
  tags: ['tcp', 'half-duplex', 'resilience', 'asymmetric', 'upload', 'download'],
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ هر اتصال کاربر به‌طور خودکار به دو اتصال TCP تبدیل می‌شود.',
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
      help: 'این پورت را در فایروال سرور ایران فقط برای IP سرور خارج باز کنید.',
    },
    {
      key: 'secureLink',
      group: 'entry',
      label: 'Protect the two halves',
      labelFa: 'رمزنگاری دو نیمه',
      type: 'select',
      default: 'tls',
      options: ['tls', 'encryption', 'none'],
      help: 'شناسه جفت‌شدگی فقط فراداده مسیریابی است و نه رمزنگاری؛ بدون این لایه هر کسی که به پورت برسد می‌تواند در نیمه دانلود تزریق کند.',
    },
    ...secretFields,
    ...destFields(),
    ...coreFields().map((f) => (f.key === '_core.mtu' ? { ...f, default: 1400 } : f)),
  ],

  build({ options }) {
    const listenPort = Number(options.listenPort) || 443;
    const linkPort = Number(options.linkPort) || 2053;
    const secure = options.secureLink || 'tls';

    // The protector has to sit between HalfDuplex and TcpConnector, because the
    // node applies it to every line it creates toward its single `next`.
    //
    // On the Iran side that means halfduplex -> protector -> connector: the
    // framing is added first and the wire carries protect(framed). The far side
    // therefore has to undo the protection *before* the HalfDuplexServer can
    // read a single frame — listener -> protector -> halfduplex -> connector.
    // A parser in front of the decryptor reads ciphertext as framing and the
    // link accepts connections and then carries nothing.
    const protector = (side, next) => {
      if (secure === 'encryption') {
        const type = side === 'iran' ? 'EncryptionClient' : 'EncryptionServer';
        return node(side === 'iran' ? 'crypt-c' : 'crypt-s', type, { password: options.password, salt: options.salt }, next);
      }
      if (secure === 'none') return null;
      if (side === 'iran') {
        return node(
          'tls-c',
          'TlsClient',
          { sni: options.sni || options.foreignHost, verify: options.verify !== false },
          next,
        );
      }
      return node(
        'tls-s',
        'TlsServer',
        { 'cert-file': CERT_PATH, 'key-file': KEY_PATH, sni: options.sni || options.foreignHost },
        next,
      );
    };

    const iranProtector = protector('iran', 'out');
    const foreignProtector = protector('foreign', 'halfduplex');

    const iranNodes = [
      node('users', 'TcpListener', { address: options.listenAddress, port: listenPort, nodelay: true }, 'halfduplex'),
      // HalfDuplexClient takes no settings; both halves go to its single `next`.
      node('halfduplex', 'HalfDuplexClient', {}, iranProtector ? iranProtector.name : 'out'),
      ...(iranProtector ? [iranProtector] : []),
      node('out', 'TcpConnector', { address: options.foreignHost, port: linkPort, nodelay: true }),
    ];

    const foreignNodes = [
      node(
        'public',
        'TcpListener',
        { address: '0.0.0.0', port: linkPort, nodelay: true, whitelist: [`${options.iranHost}/32`] },
        foreignProtector ? foreignProtector.name : 'halfduplex',
      ),
      // Decrypt first, then let the server join the two halves of each
      // connection (see the protector comment above).
      ...(foreignProtector ? [foreignProtector] : []),
      node('halfduplex', 'HalfDuplexServer', {}, 'out'),
      node('out', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort), nodelay: true }),
    ];

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: {
          'configs/half-duplex.json': j(
            chainConfig('half-duplex-iran', iranNodes),
            options,
          ),
        },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/half-duplex.json': j(
            chainConfig('half-duplex-foreign', foreignNodes),
            options,
          ),
        },
      },
      client: {
        links: [{ label: 'نقطه ورود کاربران (ایران)', url: `${options.iranHost}:${listenPort}` }],
        instructions: [
          `کاربران به ${options.iranHost}:${listenPort} وصل می‌شوند.`,
          'هیچ تنظیم اضافه‌ای در کلاینت لازم نیست؛ دو نیمه خودکار ساخته می‌شوند.',
        ],
      },
      notes: [
        `هر اتصال کاربر به دو اتصال TCP روی پورت ${linkPort} تبدیل می‌شود: یکی فقط برای ارسال، یکی فقط برای دریافت.`,
        'نیمه‌ها با یک مقدمه ۱۷ بایتی جفت می‌شوند که شامل یک شناسه تصادفی ۱۲۸ بیتی است.',
        'HalfDuplexServer هر دو نیمه را روی یک ورکر جمع می‌کند، حتی اگر روی دو اتصال جدا پذیرفته شده باشند.',
        'از آن به بعد ادامه زنجیره خارج یک اتصال معمولی واتروال می‌بیند و نیازی به دانستن دو خطی بودن ندارد.',
      ],
      warnings: [
        'پورت لینک را در فایروال سرور ایران فقط برای IP سرور خارج باز کنید؛ در غیر این صورت هر کسی می‌تواند نیمه جعلی بسازد.',
        'شناسه جفت‌شدگی رمزنگاری نیست. حتماً لایه TLS یا Encryption را روشن نگه دارید.',
        'تعداد اتصال TCP روی سرور ایران دو برابر می‌شود؛ اگر محدودیت fd دارید، workerها را کم کنید.',
        secure === 'none'
          ? 'رمزنگاری خاموش است: نیمه دانلود بدون احراز هویت است و در برابر تزریق محافظتی ندارد.'
          : 'هر دو نیمه با ' + (secure === 'tls' ? 'TLS' : 'AEAD') + ' محافظت می‌شوند؛ هر دو باید کلید یکسان داشته باشند.',
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// 2. StreamFragmenter
// ---------------------------------------------------------------------------

/**
 * `StreamFragmenter` shapes upstream bytes in two independent ways:
 *
 *  - `mode: "timed"` + `cuts` splits arbitrary payloads at given byte offsets
 *    and pauses between the pieces.
 *  - `mode: "counter"` + `tls-hello-fragment` rewrites the initial TLS
 *    ClientHello into *valid* handshake records, inserting record boundaries at
 *    the cut offsets.
 *
 * The TLS mode is the interesting one for censorship: it does not fabricate a
 * fake ClientHello (the older IpManipulator tricks), it re-frames the genuine
 * one so a DPI that waits to see a complete ClientHello has to buffer more
 * before it can classify the flow.
 *
 * The node validates everything at construction, so a bad shape is a startup
 * error. The panel therefore parses and checks the cuts before emitting them.
 */
const streamFragmenter = {
  id: 'stream-fragmenter',
  title: 'TLS ClientHello Fragmentation',
  titleFa: 'تکه‌تکه کردن ClientHello (ضد DPI)',
  category: 'stealth',
  categoryFa: 'استتار',
  icon: '✂️',
  sides: ['iran', 'foreign'],
  listenPorts: listenPorts({
    iran: ['listenPort'],
    foreign: ['linkPort'],
    relay: [],
    pairs: [],
  }),
  minVersion: '1.46.96',
  summary:
    'StreamFragmenter re-frames the initial TLS ClientHello into valid handshake records with per-cut delays. A DPI that needs a complete ClientHello to classify the connection has to buffer further.',
  summaryFa:
    'نود StreamFragmenter نخستین ClientHello واقعی TLS را به رکوردهای معتبر دست‌دادن بازتقسیم می‌کند و بین تکه‌ها تأخیر می‌گذارد. سامانه‌ای که برای تشخیص ترافیک باید ClientHello کامل را ببیند، ناچار است بیشتر بافر کند. برخلاف ترفندهای قدیمی «ClientHello جعلی»، هیچ داده ساختگی ساخته نمی‌شود.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/StreamFragmenter',
  tags: ['dpi', 'fragmentation', 'tls', 'clienthello', 'stealth', 'splice'],
  clientHint:
    'کاربران به پورت سرور ایران وصل می‌شوند. این تکنیک روی لینک ایران↔خارج اعمال می‌شود، نه روی اتصال کاربر.',
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
      key: 'mode',
      group: 'shape',
      label: 'Mode',
      labelFa: 'حالت',
      type: 'select',
      default: 'counter',
      options: ['counter', 'timed'],
      help: 'timed فقط بازه زمانی مشخصی را شامل می‌شود؛ counter هر محموله ورودی را می‌شمارد.',
    },
    {
      key: 'count',
      group: 'shape',
      label: 'Payloads to shape (counter mode)',
      labelFa: 'تعداد محموله (حالت counter)',
      type: 'number',
      default: 3,
      min: 0,
      max: 4294967295,
      when: { mode: ['counter'] },
    },
    {
      key: 'durationMs',
      group: 'shape',
      label: 'Window in ms (timed mode)',
      labelFa: 'پنجره زمانی بر حسب میلی‌ثانیه (حالت timed)',
      type: 'number',
      default: 100,
      min: 0,
      max: 4294967295,
      when: { mode: ['timed'] },
    },
    {
      key: 'cuts',
      group: 'shape',
      label: 'Cuts (offset, delay ms, chance %)',
      labelFa: 'نقاط برش (آفست، تأخیر، شانس)',
      type: 'textarea',
      default: '250,2,50\n300,5,40',
      help: 'حداکثر ۶۴ نقطه. آفست‌ها باید اکیداً صعودی باشند. مثال هر خط یک نقطه است.',
    },
    {
      key: 'bypassChance',
      group: 'shape',
      label: 'Bypass chance (%)',
      labelFa: 'شانس عبور بدون تغییر',
      type: 'number',
      default: 20,
      min: 0,
      max: 100,
      help: 'اگر انتخاب شود، این محموله اصلاً تکه‌تکه نمی‌شود.',
    },
    {
      key: 'tlsHello',
      group: 'shape',
      label: 'Fragment the TLS ClientHello',
      labelFa: 'تکه‌تکه کردن ClientHello واقعی',
      type: 'boolean',
      default: true,
      help: 'بریدن‌ها فقط روی نخستین ClientHello اعمال می‌شوند و مرزهای رکورد اصلی حفظ می‌شوند.',
    },
    {
      key: 'tlsHelloTimeoutMs',
      group: 'shape',
      label: 'ClientHello assembly timeout (ms)',
      labelFa: 'مهلت جمع‌آوری ClientHello',
      type: 'number',
      default: 1000,
      min: 1,
      max: 4294967295,
      when: { tlsHello: [true] },
      help: 'اگر ClientHello در این مدت کامل نشود، بایت‌های اصلی بدون تغییر عبور می‌کنند.',
    },
    {
      key: 'waitForEst',
      group: 'shape',
      label: 'Hold until the transport is established',
      labelFa: 'صبر تا برقراری شدن انتقال',
      type: 'boolean',
      default: true,
    },
    {
      key: 'waitForEstSeconds',
      group: 'shape',
      label: 'Wait for EST (seconds)',
      labelFa: 'مهلت انتظار برای EST (ثانیه)',
      type: 'number',
      default: 12,
      min: 1,
      max: 60,
      help: 'این تایم‌اوت متعلق به TlsClient است، نه خود Fragmenter.',
    },
    ...secretFields,
    ...destFields(),
    ...coreFields().map((f) => (f.key === '_core.mtu' ? { ...f, default: 1400 } : f)),
  ],

  build({ options }) {
    const listenPort = Number(options.listenPort) || 443;
    const linkPort = Number(options.linkPort) || 2053;
    const mode = options.mode === 'timed' ? 'timed' : 'counter';
    const cuts = parseCuts(options.cuts);

    // WaterWall rejects an empty cut array and an unknown setting at
    // construction, so refuse here with a readable message instead.
    if (!cuts.length) {
      throw new Error(
        'حداقل یک نقطه برش لازم است. قالب «250,2,50» یعنی: از بایت ۲۵۰ به بعد را با ۲ میلی‌ثانیه تأخیر و ۵۰٪ شانس بفرست.',
      );
    }
    for (let i = 1; i < cuts.length; i += 1) {
      if (cuts[i][0] === cuts[i - 1][0]) {
        throw new Error(
          'دو نقطه برش هر دو آفست ' + cuts[i][0] + ' دارند. واتروال آفست تکراری را نمی‌پذیرد؛ یکی را تغییر دهید یا یکی را حذف کنید.',
        );
      }
    }

    const fragSettings = {
      mode,
      ...(mode === 'counter'
        ? { count: Number(options.count) || 0 }
        : { 'duration-ms': Number(options.durationMs) || 0 }),
      'bypass_chance': Math.max(0, Math.min(100, Number(options.bypassChance) || 0)),
      'wait-for-est': options.waitForEst !== false,
      ...(options.tlsHello
        ? {
            'tls-hello-fragment': true,
            'tls-hello-timeout-ms': Number(options.tlsHelloTimeoutMs) || 1000,
          }
        : {}),
      cuts,
    };

    // The fragmenter must sit *upstream* of TlsClient: it shapes the bytes
    // TlsClient is about to emit.
    const iranNodes = [
      node('users', 'TcpListener', { address: options.listenAddress, port: listenPort, nodelay: true }, 'frag'),
      node('frag', 'StreamFragmenter', fragSettings, 'tls-c'),
      node(
        'tls-c',
        'TlsClient',
        {
          sni: options.sni || options.foreignHost,
          verify: options.verify !== false,
          'wait-for-est-seconds': Number(options.waitForEstSeconds) || 12,
        },
        'out',
      ),
      node('out', 'TcpConnector', { address: options.foreignHost, port: linkPort, nodelay: true }),
    ];

    const foreignNodes = [
      node(
        'public',
        'TcpListener',
        { address: '0.0.0.0', port: linkPort, nodelay: true, whitelist: [`${options.iranHost}/32`] },
        'tls-s',
      ),
      node(
        'tls-s',
        'TlsServer',
        { 'cert-file': CERT_PATH, 'key-file': KEY_PATH, sni: options.sni || options.foreignHost },
        'out',
      ),
      node('out', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort), nodelay: true }),
    ];

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: { 'configs/stream-fragmenter.json': j(chainConfig('stream-fragmenter-iran', iranNodes), options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/stream-fragmenter.json': j(chainConfig('stream-fragmenter-foreign', foreignNodes), options),
        },
      },
      client: {
        links: [{ label: 'نقطه ورود کاربران (ایران)', url: `${options.iranHost}:${listenPort}` }],
        instructions: [
          `کاربران به ${options.iranHost}:${listenPort} وصل می‌شوند.`,
          'گواهی TLS باید روی سرور خارج نصب و به مسیرهای بالا اشاره کند.',
        ],
      },
      notes: [
        `حالت «${mode}» با ${cuts.length} نقطه برش.`,
        'ترتیب اجرا: کاربر → StreamFragmenter → TlsClient → TcpConnector. گره تکه‌تکه‌سازی باید پیش از TlsClient باشد تا بایت‌هایی را شکل دهد که TLS هنوز می‌نویسد.',
        options.tlsHello
          ? 'در حالت TLS، بریدن‌ها فقط روی نخستین ClientHello اعمال می‌شوند و مرزهای رکورد اصلی حفظ می‌شوند؛ محتوای بایت‌های handshake دست‌نخورده می‌ماند.'
          : 'حالت TLS خاموش است و بریدن روی محموله‌های خام جریان انجام می‌شود.',
        'اگر قاب‌بندی TLS پشتیبانی نشود یا ClientHello بزرگ‌تر از ۶۴ کیلوبایت باشد، بایت‌های اصلی بدون تغییر عبور می‌کنند.',
      ],
      warnings: [
        'هر تنظیم ناشناخته یا نامعتبر در این نود باعث خطای اجرا می‌شود؛ پنل نقاط برش را پیش از تولید بررسی می‌کند.',
        'آفست‌ها باید اکیداً صعودی و حداکثر ۶۴ عدد باشند.',
        'بیش از ۶۴ نقطه یا آفست تکراری باعث رد کانفیگ می‌شود.',
        'این کار فقط روی لینک ایران↔خارج اثر دارد. ترافیک کاربر تا سرور ایران همچنان عادی است.',
        'روی MTU کوچک یا مسیرهایی که TCP segmentation را دستکاری می‌کنند ممکن است اثر معکوس بدهد؛ با تست سرعت مقایسه کنید.',
        'TlsClient هم از تکه‌تکه کردن داخلی پشتیبانی می‌کند؛ اگر آن را فعال کرده‌اید، دو مکانیزم را با هم ترکیب نکنید مگر با دقت.',
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// 3. ConnectionFisher
// ---------------------------------------------------------------------------

/**
 * `ConnectionFisherClient` opens up to `simultaneous-tries-perline` internal
 * child lines toward its single `next` node, sends a fixed 5-byte `FISH?` probe
 * on each, and keeps the first that receives `FISH!`. Everything else is
 * closed.
 *
 * Being accurate about what this buys: all children go to the *same* `next`,
 * so this races connections to one endpoint, not to different foreign
 * servers. What you get is that whichever of N parallel TCP connections gets a
 * working path first is the one you keep — useful when a single connection can
 * land on a degraded path, and when you want the tail latency of the best of
 * several attempts rather than the average of one.
 *
 * The `FISH?`/`FISH!` markers are a fixed, unsecret probe. They prove the peer
 * is a matching ConnectionFisherServer; they are not authentication.
 */
const connectionFisher = {
  id: 'connection-fisher',
  title: 'Connection Fisher (race several paths)',
  titleFa: 'رقابت مسیرها (Connection Fisher)',
  category: 'resilience',
  categoryFa: 'پایداری',
  icon: '🎣',
  sides: ['iran', 'foreign'],
  listenPorts: listenPorts({
    iran: ['listenPort'],
    foreign: ['linkPort'],
    relay: [],
    pairs: [],
  }),
  minVersion: '1.46.96',
  summary:
    'ConnectionFisherClient opens several connections at once toward the same peer and keeps the first that answers a probe. The slowest attempts are closed immediately.',
  summaryFa:
    'ConnectionFisherClient چند اتصال را همزمان به یک مقصد باز می‌کند و روی هرکدام یک پروب ثابت می‌فرستد؛ هرکدام زودتر پاسخ دهد نگه داشته می‌شود و بقیه بسته می‌شوند. نتیجه: تأخیر دنباله‌ای بهترینِ چند تلاش، نه میانگینِ یک تلاش.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/ConnectionFisherClient',
  tags: ['resilience', 'latency', 'redundancy', 'stream'],
  clientHint: 'کاربران به پورت سرور ایران وصل می‌شوند؛ انتخاب مسیر پشت‌صحنه انجام می‌شود.',
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
      key: 'simultaneousTries',
      group: 'fisher',
      label: 'Simultaneous tries per connection',
      labelFa: 'تعداد تلاش همزمان',
      type: 'number',
      default: 3,
      min: 1,
      max: 16,
      required: true,
      help: 'برای هر اتصال کاربر چند خط داخلی ساخته شود. مقادیر کمتر از ۱ رد می‌شوند.',
    },
    {
      key: 'innerSecure',
      group: 'fisher',
      label: 'Encrypt inside the raced lines',
      labelFa: 'رمزنگاری داخل خطوط رقابتی',
      type: 'select',
      default: 'tls',
      options: ['tls', 'encryption', 'none'],
      help: 'پروب FISH? ثابت و بدون رمز است؛ این لایه اصالت و محرمانگی را اضافه می‌کند.',
    },
    ...secretFields,
    ...destFields(),
    ...coreFields().map((f) => (f.key === '_core.mtu' ? { ...f, default: 1400 } : f)),
  ],

  build({ options }) {
    const listenPort = Number(options.listenPort) || 443;
    const linkPort = Number(options.linkPort) || 2053;
    // Number(x) || 3 would silently turn an explicit 0 into 3, so read the
    // value as given and validate it: WaterWall rejects anything below 1.
    const tries = Number.isFinite(Number(options.simultaneousTries))
      ? Math.trunc(Number(options.simultaneousTries))
      : 3;
    if (tries < 1) throw new Error('تعداد تلاش همزند باید حداقل ۱ باشد؛ واتروال مقادیر کمتر از ۱ را رد می‌کند.');
    const secure = options.innerSecure || 'tls';

    const iranProtector =
      secure === 'encryption'
        ? node('crypt-c', 'EncryptionClient', { password: options.password, salt: options.salt }, 'out')
        : secure === 'none'
          ? null
          : node(
              'crypt-c',
              'TlsClient',
              { sni: options.sni || options.foreignHost, verify: options.verify !== false },
              'out',
            );

    const foreignProtector =
      secure === 'encryption'
        ? node('crypt-s', 'EncryptionServer', { password: options.password, salt: options.salt }, 'fisher')
        : secure === 'none'
          ? null
          : node(
              'crypt-s',
              'TlsServer',
              { 'cert-file': CERT_PATH, 'key-file': KEY_PATH, sni: options.sni || options.foreignHost },
              'fisher',
            );

    const iranNodes = [
      node('users', 'TcpListener', { address: options.listenAddress, port: listenPort, nodelay: true }, 'fisher'),
      node(
        'fisher',
        'ConnectionFisherClient',
        { 'simultaneous-tries-perline': tries },
        iranProtector ? iranProtector.name : 'out',
      ),
      ...(iranProtector ? [iranProtector] : []),
      node('out', 'TcpConnector', { address: options.foreignHost, port: linkPort, nodelay: true }),
    ];

    // The server must see the same FISH? bytes, so with a tunnel in between the
    // decoder runs first and the fisher node comes after it.
    const foreignNodes = [
      node(
        'public',
        'TcpListener',
        { address: '0.0.0.0', port: linkPort, nodelay: true, whitelist: [`${options.iranHost}/32`] },
        foreignProtector ? foreignProtector.name : 'fisher',
      ),
      ...(foreignProtector ? [foreignProtector] : []),
      node('fisher', 'ConnectionFisherServer', {}, 'out'),
      node('out', 'TcpConnector', { address: options.destAddress, port: Number(options.destPort), nodelay: true }),
    ];

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: { 'configs/connection-fisher.json': j(chainConfig('fisher-iran', iranNodes), options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: {
          'configs/connection-fisher.json': j(chainConfig('fisher-foreign', foreignNodes), options),
        },
      },
      client: {
        links: [{ label: 'نقطه ورود کاربران (ایران)', url: `${options.iranHost}:${listenPort}` }],
        instructions: [`کاربران به ${options.iranHost}:${listenPort} وصل می‌شوند.`],
      },
      notes: [
        `برای هر اتصال کاربر تا ${tries} خط داخلی ساخته می‌شود و روی هرکدام پروب FISH? فرستاده می‌شود.`,
        'هرکدام که زودتر FISH! برگرداند برنده است؛ بقیه خطوط بسته و داده‌های در صف آزاد می‌شوند.',
        'دقت کنید: همه خطوط رقابتی به یک next می‌روند، پس این نود بین چند سرور خارج رقابت نمی‌کند — بین چند اتصال به همان یک مقصد رقابت می‌کند.',
      ],
      warnings: [
        'پروب FISH?/FISH! ثابت و بدون رمز است و فقط نشان می‌دهد مقصد یک ConnectionFisherServer متناظر است؛ نه احراز هویت است و نه یکپارچگی داده.',
        `با ${tries} تلاش همزمان، لحظه‌ای تا ${tries} اتصال TCP روی سرور ایران باز می‌شود. روی سرور کم‌منابع این عدد را کم کنید.`,
        'پورت لینک را فقط برای IP سرور خارج باز کنید؛ این پورت جز پروب پاسخ چیز دیگری نمی‌پذیرد.',
        secure === 'none'
          ? 'بدون لایه امنیتی: پروب قابل جعل است و ترافیک روی سیم خوانا می‌ماند.'
          : '',
      ].filter(Boolean),
    };
  },
};

module.exports = [halfDuplex, streamFragmenter, connectionFisher];


