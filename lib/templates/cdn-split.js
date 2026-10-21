'use strict';

/**
 * CDN-fronted reverse tunnel over HTTP/1.1 split mode.
 *
 * This is the template for the question "can a reverse tunnel go through
 * Cloudflare with XHTTP-style padding obfuscation so the CDN does not block
 * it?".
 *
 * ## What XHTTP actually is, and why it cannot be used here verbatim
 *
 * XHTTP (SplitHTTP) is an Xray-core transport, not an HTTP feature. Its wire
 * format is Xray-specific: a session table on the server, `X-Stream-Data`
 * framing, `sessionID`/`seq` cookies, `scMaxEachPostBytes`,
 * `scMinPostsIntervalMs`, `noSSEHeader`, and padding injected as
 * `xPaddingBytes`/`xPaddingPlacement`/`xPaddingObfsMode`. Both ends must
 * speak it, which means the origin has to be an Xray inbound with
 * `xhttpSettings`. WaterWall has no XHTTP node, so a WaterWall-to-WaterWall
 * link using real XHTTP framing is not buildable.
 *
 * ## What WaterWall does have, and why it is the right answer
 *
 * `HttpClient`/`HttpServer` support `http1-mode: "split"`. That mode carries
 * one tunnel line as *two* independent HTTP/1.1 requests:
 *
 *   upload half   -> a POST carrying the payload toward the origin
 *   download half -> a GET receiving the response body from the origin
 *
 * The two halves are paired by a shared metadata id, a direction marker and an
 * optional token. This is functionally the same idea as XHTTP's `stream-up`
 * mode, and it solves the same problem XHTTP was designed to solve: a CDN
 * (or any middlebox) that buffers or times out a long bidirectional HTTP/1.1
 * request/response on one connection. Because each half is a separate
 * short-lived request, the CDN sees ordinary web traffic instead of one
 * connection that never completes.
 *
 * The pairing id is *not* a secret. It is routing metadata, exactly as the
 * WaterWall docs say. A shared `token` is available for deployments that want
 * one, and the `linkEncryption` option in this template puts a real AEAD
 * layer inside the carrier for everything else.
 *
 * ## On the padding
 *
 * XHTTP's padding exists to make the request look like ordinary web traffic
 * to a DPI that is looking for the XHTTP session pattern. WaterWall's split
 * mode has no padding knob, because it does not need one: the split shape
 * already looks like a normal POST plus a normal GET against a path, and
 * `cache-bypass` adds changing metadata so the CDN does not serve a cached
 * response. If DPI resistance against the *server* is the goal rather than
 * CDN compatibility, use the `tls13-record-shaping` padding on `TlsClient`
 * (see the `first-sni` and `sni-blender` templates) — that is the
 * transport-layer equivalent, and it is where padding actually belongs.
 *
 * ## Topology
 *
 *   users ─▶ CDN ─▶ Iran origin ─▶ ReverseServer ─┐
 *                                                  │ two HTTP/1.1 requests
 *   foreign service ◀─ ReverseClient ◀─────────────┘ (upload POST + download GET)
 *
 * The foreign box dials out through the CDN, so the Iran box needs no
 * reachable inbound path of its own. Both halves travel through the same CDN
 * hostname, so the origin only ever sees the CDN, not the exit servers.
 */

const { coreOpts, csv, node } = require('./common');
const { emitConfig } = require('../generator');

const emit = (config, options) => emitConfig(config, { useVariables: options.useVariables !== false });

/**
 * A current desktop Chrome string.
 *
 * The default in the node (`WaterWall/1.x`) announces the tunnel in a header
 * that any middlebox reads, which defeats the point of going through a CDN.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Request headers that make the opening request look like an XHR from a page
 * rather than a client with nothing to say. `cache-control: no-cache` also
 * keeps the CDN from serving a cached response to a tunnel request.
 */
const BROWSER_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
};

const cdnSplitFields = [
  {
    key: 'cdnHost',
    group: 'cdn',
    label: 'Domain behind the CDN',
    labelFa: 'دامنه پشت CDN',
    type: 'text',
    default: 'cdn.example.com',
    required: true,
    help:
      'دامنه‌ای که در CDN ثبت کرده‌اید و به IP سرور ایران اشاره می‌کند. هم SNI دست‌دادن TLS می‌شود و هم هدر Host، پس CDN می‌فهمد کدام سایت را باید به origin بفرستد.',
  },
  {
    key: 'cdnPort',
    group: 'cdn',
    label: 'CDN port',
    labelFa: 'پورت CDN',
    type: 'number',
    default: 443,
    min: 1,
    max: 65535,
    required: true,
    help: 'پورتی که بقیه به آن وصل می‌شوند. ۴۴۳ طبیعی‌ترین انتخاب است.',
  },
  {
    key: 'edgeAddress',
    group: 'cdn',
    label: 'Pinned edge address',
    labelFa: 'آدرس لبه ثابت',
    type: 'text',
    default: '',
    help:
      'اختیاری، معادل edge_ip در بکهال. اگر پر شود، اتصال به این IP می‌رود ولی نام در SNI و Host همان دامنه می‌ماند. برای قفل کردن روی یک لبه سریع یا وقتی DNS سرور خارج دامنه را به IP فیلترشده resolve می‌کند.',
  },
  {
    key: 'originTls',
    group: 'cdn',
    label: 'CDN connects to the origin over TLS',
    labelFa: 'اتصال CDN به origin روی TLS',
    type: 'boolean',
    default: false,
    help:
      'اگر CDN خودش TLS را در لبه خاتمه می‌دهد (حالت پیش‌فرض آروان‌کلاود و کلاودفلر)، روشن نگذارید تا TlsServer روی ایران حذف شود. اگر CDN ترافیک TLS را دست‌نخورده عبور می‌دهد یا origin protocol روی HTTPS است، روشن کنید تا گواهی روی ایران لازم شود.',
  },
  {
    key: 'splitPath',
    group: 'cdn',
    label: 'Split-mode path',
    labelFa: 'مسیر حالت split',
    type: 'text',
    default: '/api/v1/sync',
    required: true,
    help:
      'روی هر دو طرف دقیقاً یکسان می‌شود. مسیری انتخاب کنید که با بقیه همان سایت بخورد، مثل /api/v1/sync — نه /ws. در split mode می‌توانید از قالب {id} و {direction} هم داخل مسیر استفاده کنید.',
  },
  {
    key: 'userAgent',
    group: 'cdn',
    label: 'User-Agent',
    labelFa: 'User-Agent',
    type: 'text',
    default: DEFAULT_USER_AGENT,
    help: 'هدر User-Agent در دست‌دادن. پیش‌فرض یک کروم دسکتاپ واقعی است.',
  },
  {
    key: 'expectedHost',
    group: 'cdn',
    label: 'Host the origin requires',
    labelFa: 'Host مورد انتظار در origin',
    type: 'text',
    default: '',
    help:
      'اختیاری. فقط روی HttpServer سرور ایران اعمال می‌شود: اگر پر شود، درخواست‌هایی که این Host را ندارند رد می‌شوند — یک لایه محافظت در برابر پروب مستقیم روی IP سرور ایران. روی Hostی که سرور خارج می‌فرستد اثری ندارد، چون آن باید همان دامنه CDN بماند.',
  },
  {
    key: 'splitTokenEnabled',
    group: 'split',
    label: 'Use a shared split token',
    labelFa: 'استفاده از توکن مشترک split',
    type: 'boolean',
    default: false,
    help:
      'یک رشته مشترک که هر دو نیمه‌ی درخواست باید داشته باشند تا جفت شوند. توکن در header یا query می‌رود، پس به‌عنوان راز کوچک در نظرش بگیرید نه راز بزرگ. اگر فقط به لایهٔ رمزنگاری داخلی اعتماد دارید، خاموش بگذارید.',
  },
  {
    key: 'splitToken',
    group: 'split',
    label: 'Shared split token',
    labelFa: 'توکن مشترک split',
    type: 'password',
    default: 'auto:password',
    when: { splitTokenEnabled: true },
    help: 'همان مقدار باید روی هر دو طرف باشد. با دکمهٔ 🎲 یک توکن تصادفی بسازید یا خالی بگذارید تا خودکار ساخته شود.',
  },
  {
    key: 'splitTokenPlacement',
    group: 'split',
    label: 'Where the token is placed',
    labelFa: 'محل قرارگیری توکن',
    type: 'select',
    default: 'header',
    options: ['header', 'query', 'cookie'],
    when: { splitTokenEnabled: true },
    help:
      'header معمولاً تمیزتر است چون query string را در لاگ‌های CDN نمی‌بینید. اگر header را انتخاب کردید، نام هدر را هم یکتا نگه دارید.',
  },
  {
    key: 'splitTokenName',
    group: 'split',
    label: 'Token field name',
    labelFa: 'نام فیلد توکن',
    type: 'text',
    default: 'X-Waterwall-Token',
    when: { splitTokenEnabled: true },
    help: 'نام هدر یا پارامتری که توکن داخلش می‌رود. روی هر دو طرف یکسان.',
  },
  {
    key: 'splitIdPlacement',
    group: 'split',
    label: 'Where the pairing id is placed',
    labelFa: 'محل قرارگیری id جفت‌سازی',
    type: 'select',
    default: 'query',
    options: ['query', 'header', 'cookie', 'path'],
    help:
      'id جفت‌سازی یک مقدار تصادفی ۱۲۸ بیتی است که سرور خارج برای هر اتصال تازه می‌سازد و سرور ایران با آن دو نیمه را جفت می‌کند. این راز نیست؛ صرفاً metadata مسیریابی است.',
  },
  {
    key: 'splitIdName',
    group: 'split',
    label: 'Pairing id field name',
    labelFa: 'نام فیلد id',
    type: 'text',
    default: 'wwid',
    help: 'نام فیلدی که id در آن قرار می‌گیرد. روی هر دو طرف یکسان.',
  },
  {
    key: 'cacheBypass',
    group: 'split',
    label: 'Add cache-bypass metadata',
    labelFa: 'افزودن متادیتای ضدکش',
    type: 'boolean',
    default: true,
    help:
      'یک مقدار متغیر به هر درخواست اضافه می‌کند تا CDN جواب کش‌شده را برنگرداند. روشن بماند، وگرنه ممکن است پاسخ‌های تونل با هم قاطی شوند.',
  },
  {
    key: 'useMux',
    group: 'mux',
    label: 'Multiplex users over few connections',
    labelFa: 'چندگانه‌سازی کاربران روی چند اتصال',
    type: 'boolean',
    default: true,
    help:
      'MuxServer روی ایران و MuxClient روی خارج، چند اتصال کاربر را جمع می‌کنند تا تعداد درخواست‌های HTTP کم شود. اگر CDN تعداد کانکشن را محدود می‌کند روشن نگه دارید.',
  },
  {
    key: 'linkEncryption',
    group: 'crypto',
    label: 'Encrypt the reverse link inside the CDN',
    labelFa: 'رمزنگاری لینک معکوس داخل CDN',
    type: 'boolean',
    default: true,
    help:
      'یک لایهٔ AEAD واقعی بین سرور ایران و سرور خارج اضافه می‌کند (EncryptionServer/Client) که داخل حامل HTTP قرار می‌گیرد. CDN فقط بایت‌های رمزشده را می‌بیند. برای تونل‌های جدید روشن بماند.',
  },
  {
    key: 'linkEncryptPassword',
    group: 'crypto',
    label: 'Link encryption password',
    labelFa: 'رمز رمزنگاری لینک',
    type: 'password',
    default: 'auto:password',
    when: { linkEncryption: true },
    required: true,
    help: 'هر دو طرف از همین رمز استفاده می‌کنند. خودکار ساخته و ذخیره می‌شود.',
  },
  {
    key: 'linkEncryptAlgorithm',
    group: 'crypto',
    label: 'Link encryption algorithm',
    labelFa: 'الگوریتم رمزنگاری لینک',
    type: 'select',
    default: 'chacha20-poly1305',
    options: ['chacha20-poly1305', 'aes-256-gcm'],
    when: { linkEncryption: true },
    help: 'الگوریتم AEAD. پیش‌فرض برای CPUهای بدون AES-NI مناسب‌تر است.',
  },
  {
    key: 'userPort',
    group: 'entry',
    label: 'User-facing port (Iran)',
    labelFa: 'پورت کاربران (ایران)',
    type: 'number',
    default: 443,
    min: 1,
    max: 65535,
    required: true,
    help: 'پورتی روی سرور ایران که کاربران به آن وصل می‌شوند.',
  },
  {
    key: 'originPort',
    group: 'entry',
    label: 'Origin port (Iran)',
    labelFa: 'پورت origin (ایران)',
    type: 'number',
    default: 8443,
    min: 1,
    max: 65535,
    required: true,
    help: 'پورتی روی سرور ایران که CDN به آن وصل می‌شود. فقط برای IPهای خروجی CDN باز باشد.',
  },
  {
    key: 'listenAddress',
    group: 'entry',
    label: 'Bind address (Iran)',
    labelFa: 'آدرس bind (ایران)',
    type: 'text',
    default: '0.0.0.0',
    help: 'آدرسی که هر دو شنونده روی ایران روی آن گوش می‌دهند.',
  },
  {
    key: 'whitelist',
    group: 'entry',
    label: 'Origin whitelist (CDN egress IPs)',
    labelFa: 'لیست سفید origin (IPهای خروجی CDN)',
    type: 'list',
    default: [],
    placeholder: '104.16.0.0/12',
    help: 'بازه‌های IP که CDN از آن‌ها به origin می‌زند. خالی بگذارید یعنی هر کسی که پورت را پیدا کند می‌تواند دست‌دادن را امتحان کند.',
  },
  {
    key: 'minimumUnused',
    group: 'reverse',
    label: 'Minimum held connections',
    labelFa: 'حداقل اتصال نگه‌داشته‌شده',
    type: 'number',
    default: 8,
    min: 0,
    max: 1000,
    help: 'ReverseClient این تعداد اتصال را از پیش باز نگه می‌دارد تا اولین درخواست کاربر تأخیر نداشته باشد.',
  },
  {
    key: 'reverseSecret',
    group: 'reverse',
    label: 'Shared reverse secret',
    labelFa: 'راز مشترک لینک معکوس',
    type: 'password',
    default: '',
    help: 'اختیاری. یک راز مشترک بین ReverseClient و ReverseServer، جدا از رمزنگاری لینک.',
  },
  {
    key: 'domain',
    group: 'tls',
    label: 'Domain for an automatic certificate (Iran)',
    labelFa: 'دامنه برای گواهی خودکار (ایران)',
    type: 'text',
    default: '',
    help: 'فقط وقتی لازم است که CDN ترافیک TLS را دست‌نخورده عبور بدهد (origin protocol = https).',
  },
  {
    key: 'certMode',
    group: 'tls',
    label: 'How to obtain the certificate',
    labelFa: 'روش گرفتن گواهی',
    type: 'select',
    default: 'none',
    options: ['none', 'letsencrypt', 'selfsigned'],
    when: { originTls: true },
    help: 'روش ساخت گواهی TLS برای origin.',
  },
  {
    key: 'certEmail',
    group: 'tls',
    label: 'Certificate email',
    labelFa: 'ایمیل گواهی',
    type: 'text',
    default: '',
    when: { originTls: true },
    help: 'برای Let\'s Encrypt لازم است.',
  },
  {
    key: 'certPath',
    group: 'tls',
    label: 'Certificate path (Iran)',
    labelFa: 'مسیر گواهی (ایران)',
    type: 'text',
    default: '/home/admin/domains/example.com/ssl/example.com.crt',
    when: { originTls: true },
    required: true,
    help: 'TlsServer.cert-file روی سرور ایران.',
  },
  {
    key: 'keyPath',
    group: 'tls',
    label: 'Private key path (Iran)',
    labelFa: 'مسیر کلید (ایران)',
    type: 'text',
    default: '/home/admin/domains/example.com/ssl/example.com.key',
    when: { originTls: true },
    required: true,
    help: 'TlsServer.key-file روی سرور ایران.',
  },
  {
    key: 'verify',
    group: 'tls',
    label: 'Verify the CDN certificate',
    labelFa: 'بررسی گواهی CDN',
    type: 'boolean',
    default: true,
    help: 'TlsClient.verify — CDN یک گواهی معتبر برای دامنه ارائه می‌دهد، پس true بماند.',
  },
  {
    key: 'tlsMinVersion',
    group: 'tls',
    label: 'Min TLS version',
    labelFa: 'کمینه نسخه TLS',
    type: 'select',
    default: 'TLSv1.2',
    options: ['TLSv1.2', 'TLSv1.3'],
  },
  {
    key: 'tlsMaxVersion',
    group: 'tls',
    label: 'Max TLS version',
    labelFa: 'بیشینه نسخه TLS',
    type: 'select',
    default: 'TLSv1.3',
    options: ['TLSv1.2', 'TLSv1.3'],
  },
  {
    key: 'localServiceAddress',
    group: 'service',
    label: 'Local service address (foreign)',
    labelFa: 'آدرس سرویس محلی (خارج)',
    type: 'text',
    default: '127.0.0.1',
    help: 'سرویسی روی سرور خارج که ترافیک کاربران به آن می‌رسد.',
  },
  {
    key: 'finalPort',
    group: 'service',
    label: 'Local service port (foreign)',
    labelFa: 'پورت سرویس محلی (خارج)',
    type: 'number',
    default: 8080,
    min: 1,
    max: 65535,
    required: true,
    help: 'پورت سرویس محلی روی سرور خارج.',
  },
  {
    key: 'useVariables',
    group: 'advanced',
    label: 'Use $variables$ in the config',
    labelFa: 'استفاده از $variables$ در کانفیگ',
    type: 'boolean',
    default: true,
    help: 'مقادیر قابل تغییر به‌صورت متغیر در کانفیگ نوشته می‌شوند تا بعداً بدون ویرایش ساختار قابل تغییر باشند.',
  },
];

const cdnReverseSplit = {
  id: 'cdn-reverse-split',
  title: 'Reverse tunnel over HTTP/1.1 split mode behind a CDN',
  titleFa: 'تونل معکوس با HTTP/1.1 split پشت CDN',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '🌗',
  sides: ['iran', 'foreign'],
  summary:
    'Iran: TcpListener(origin) -> [TlsServer] -> HttpServer(split) -> [MuxServer] -> ReverseServer -> Bridge ⇄ Bridge <- TcpListener(users).  Foreign: TcpConnector -> TlsClient -> HttpClient(split) -> [MuxClient] -> ReverseClient -> Bridge ⇄ Bridge -> local service.  Each tunnel line travels as two separate HTTP/1.1 requests (a POST for the upload half and a GET for the download half) paired by a shared id, which is the XHTTP-style shape that keeps a buffering CDN from stalling the link.',
  summaryFa:
    'همان تونل معکوس CDN، اما به‌جای یک وب‌سوکت بلند، هر خط تونل به دو درخواست HTTP/1.1 جدا شکسته می‌شود: یک POST برای آپلود و یک GET برای دانلود، که با یک id مشترک جفت می‌شوند. این همان شکلی است که XHTTP انجام می‌دهد و جلوی گیر کردن لینک پشت CDNی که درخواست‌های طولانی را بافر می‌کند را می‌گیرد.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/HttpServer',
  tags: ['cdn', 'split', 'http1', 'reverse', 'tls', 'mux', 'cloudflare', 'backhaul', 'xhttp'],
  // Every exit dials the same CDN hostname, so any number of them can share the
  // entry; the origin only sees the CDN, not the individual exit servers.
  multiExit: true,
  clientHint:
    'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی ترافیک آن‌ها سرویس محلی روی سرور خارج است. هر خط تونل از داخل CDN به دو درخواست HTTP جدا شکسته می‌شود.',
  fields: cdnSplitFields,

  build({ options }) {
    const userPort = Number(options.userPort) || 443;
    const originPort = Number(options.originPort) || 8443;
    const cdnPort = Number(options.cdnPort) || 443;
    const cdnHost = String(options.cdnHost || '').trim() || 'cdn.example.com';
    const useVars = options.useVariables !== false;
    const originTls = options.originTls === true;
    const useMux = options.useMux !== false;
    const splitPath = String(options.splitPath || '/api/v1/sync');
    const cdnAddress = String(options.edgeAddress || '').trim() || cdnHost;
    const expectedHost = String(options.expectedHost || '').trim();
    const cdnCidr = csv(options.whitelist);

    // Split mode is HTTP/1.1 only and cannot be combined with websocket, so
    // there is no version to negotiate here. The ALPN offer follows from that:
    // an HTTP/1.1 client has to offer http/1.1 and nothing else, or the CDN
    // may pick h2 and the two ends will disagree about the protocol.
    const alpn = 'http/1.1';

    // ReverseClient takes "minimum-unused"; ReverseServer does not.
    const clientReverse = { 'minimum-unused': Number(options.minimumUnused) || 8 };
    const serverReverse = {};
    if (options.reverseSecret) {
      const len = Math.max(1, Math.min(1024, Buffer.byteLength(options.reverseSecret)));
      clientReverse['reverse-secret'] = options.reverseSecret;
      clientReverse['reverse-secret-length'] = len;
      serverReverse['reverse-secret'] = options.reverseSecret;
      serverReverse['reverse-secret-length'] = len;
    }

    const muxClientSettings = { mode: options.muxMode || 'timer' };
    if ((options.muxMode || 'timer') === 'timer') {
      muxClientSettings['connection-duration-ms'] = Number(options.muxConnectionDurationMs) || 30000;
    }
    if (options.muxMode === 'counter') {
      muxClientSettings['connection-capacity'] = Number(options.muxConnectionCapacity) || 128;
    }
    if (options.muxMode === 'fixed-connections-count') {
      muxClientSettings['per-worker-connections-count'] = Number(options.muxPerWorkerConnections) || 2;
    }
    const maxChildren = Number(options.muxMaxChildren) || 10000;
    muxClientSettings['max-children'] = maxChildren;

    // The optional AEAD layer sits *inside* the HTTP carrier, between the
    // Mux/HTTP pair and the Reverse pair. It protects the reverse-link stream
    // from the CDN and from anything that terminates TLS at the edge; the
    // HTTP framing itself is unchanged.
    const linkEncryption = options.linkEncryption === true;
    const linkCrypto = linkEncryption
      ? {
          password: options.linkEncryptPassword,
          algorithm: options.linkEncryptAlgorithm || 'chacha20-poly1305',
          // Pin the documented defaults on both peers instead of inheriting
          // them: a future core changing a default must not silently break an
          // encrypted link that was built before the change.
          salt: 'waterwall-encryption',
          'kdf-iterations': 12000,
          'max-frame-size': 16356,
        }
      : null;

    // The split pairing settings have to be byte-identical on both peers or
    // the two halves never meet. They are built once here and handed to both
    // nodes so the two sides cannot drift apart.
    const splitSettings = {
      'upload-method': 'POST',
      'download-method': 'GET',
      'id-placement': String(options.splitIdPlacement || 'query'),
      'id-name': String(options.splitIdName || 'wwid'),
      'direction-placement': 'query',
      'direction-name': 'wwdir',
      'upload-value': 'upload',
      'download-value': 'download',
      'cache-bypass': options.cacheBypass !== false,
    };
    if (options.splitTokenEnabled !== false && options.splitToken) {
      splitSettings.token = options.splitToken;
      splitSettings['token-placement'] = String(options.splitTokenPlacement || 'header');
      splitSettings['token-name'] = String(options.splitTokenName || 'X-Waterwall-Token');
    }

    const httpServerSettings = {
      'http-version': 1,
      'http1-mode': 'split',
      path: splitPath,
      method: 'POST',
      status: 200,
      split: { ...splitSettings },
      ...(expectedHost ? { host: expectedHost } : {}),
    };

    const httpClientSettings = {
      host: cdnHost,
      path: splitPath,
      scheme: 'https',
      port: cdnPort,
      method: 'POST',
      'http-version': 1,
      'http1-mode': 'split',
      'user-agent': options.userAgent || DEFAULT_USER_AGENT,
      headers: { ...BROWSER_HEADERS },
      split: { ...splitSettings },
    };

    const tlsServerSettings = {
      'cert-file': options.certPath,
      'key-file': options.keyPath,
      'min-version': options.tlsMinVersion,
      'max-version': options.tlsMaxVersion,
      'select-alpns': [alpn],
    };

    // ----------------------------------------------------------- Iran side
    const iranNodes = [
      node(
        'users_inbound',
        'TcpListener',
        {
          address: options.listenAddress,
          port: userPort,
          nodelay: true,
          'large-send-buffer': true,
          'large-recv-buffer': true,
        },
        'bridge_user_side',
      ),
      node('bridge_user_side', 'Bridge', { pair: 'bridge_reverse_side' }),
      // No `next`: `pair` already binds the two bridges, and a Bridge that also
      // names its partner as `next` is rejected when the config loads.
      node('bridge_reverse_side', 'Bridge', { pair: 'bridge_user_side' }),
      node('reverse_server', 'ReverseServer', serverReverse, 'bridge_reverse_side'),
    ];
    const reverseCarrier = linkEncryption ? 'encryption_server' : 'reverse_server';
    if (linkEncryption) {
      iranNodes.push(
        node('encryption_server', 'EncryptionServer', { ...linkCrypto }, 'reverse_server'),
      );
    }
    if (useMux) {
      iranNodes.push(node('mux_origin', 'MuxServer', { 'max-children': maxChildren }, reverseCarrier));
    }
    iranNodes.push(
      node('http_origin', 'HttpServer', httpServerSettings, useMux ? 'mux_origin' : reverseCarrier),
    );
    if (originTls) {
      iranNodes.push(node('tls_origin', 'TlsServer', tlsServerSettings, 'http_origin'));
    }
    iranNodes.push(
      node(
        'cdn_inbound',
        'TcpListener',
        {
          address: options.listenAddress,
          port: originPort,
          nodelay: true,
          'large-send-buffer': true,
          'large-recv-buffer': true,
          ...(cdnCidr.length ? { whitelist: cdnCidr } : {}),
        },
        originTls ? 'tls_origin' : 'http_origin',
      ),
    );

    const iranConfig = {
      name: 'iran-cdn-reverse-split-server',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              cdn_domain: cdnHost,
              cdn_port: cdnPort,
              origin_port: originPort,
              users_inbound_port: userPort,
              ...(linkEncryption
                ? { link_password: options.linkEncryptPassword, link_algorithm: linkCrypto.algorithm }
                : {}),
              ...(originTls ? { certificate_path: options.certPath, key_path: options.keyPath } : {}),
            },
          }
        : {}),
      nodes: iranNodes.map((n) => {
        if (!useVars) return n;
        const copy = JSON.parse(JSON.stringify(n));
        if (copy.name === 'cdn_inbound') copy.settings.port = '@origin_port';
        if (copy.name === 'users_inbound') copy.settings.port = '@users_inbound_port';
        if (copy.name === 'tls_origin') {
          copy.settings['cert-file'] = '@certificate_path';
          copy.settings['key-file'] = '@key_path';
        }
        if (copy.name === 'encryption_server') {
          copy.settings.password = '@link_password';
          copy.settings.algorithm = '@link_algorithm';
        }
        return copy;
      }),
    };

    // -------------------------------------------------------- Foreign side
    const foreignNodes = [
      node('outbound_to_local_service', 'TcpConnector', {
        address: options.localServiceAddress || '127.0.0.1',
        port: Number(options.finalPort) || 8080,
        nodelay: true,
      }),
      node('bridge_local_side', 'Bridge', { pair: 'bridge_reverse_client_side' }, 'outbound_to_local_service'),
      node('bridge_reverse_client_side', 'Bridge', { pair: 'bridge_local_side' }, 'reverse_client'),
      node(
        'reverse_client',
        'ReverseClient',
        clientReverse,
        linkEncryption ? 'encryption_client' : useMux ? 'mux_client' : 'http_client',
      ),
    ];
    if (linkEncryption) {
      foreignNodes.push(
        node('encryption_client', 'EncryptionClient', { ...linkCrypto }, useMux ? 'mux_client' : 'http_client'),
      );
    }
    if (useMux) {
      foreignNodes.push(node('mux_client', 'MuxClient', muxClientSettings, 'http_client'));
    }
    foreignNodes.push(node('http_client', 'HttpClient', httpClientSettings, 'tls_client'));
    foreignNodes.push(
      node('tls_client', 'TlsClient', { sni: cdnHost, verify: options.verify !== false, alpns: [alpn] }, 'tcp_to_cdn'),
    );
    foreignNodes.push(node('tcp_to_cdn', 'TcpConnector', { address: cdnAddress, port: cdnPort, nodelay: true }));

    const foreignConfig = {
      name: 'foreign-cdn-reverse-split-client',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(useVars
        ? {
            variables: {
              cdn_domain: cdnHost,
              cdn_port: cdnPort,
              ip_cdn_or_edge: cdnAddress,
              final_port: Number(options.finalPort) || 8080,
              min_held_connections: Number(options.minimumUnused) || 8,
              ...(linkEncryption
                ? { link_password: options.linkEncryptPassword, link_algorithm: linkCrypto.algorithm }
                : {}),
            },
          }
        : {}),
      nodes: foreignNodes.map((n) => {
        if (!useVars) return n;
        const copy = JSON.parse(JSON.stringify(n));
        if (copy.name === 'tcp_to_cdn') {
          copy.settings.address = '@ip_cdn_or_edge';
          copy.settings.port = '@cdn_port';
        }
        if (copy.name === 'tls_client') copy.settings.sni = '@cdn_domain';
        if (copy.name === 'reverse_client') copy.settings['minimum-unused'] = '@min_held_connections';
        if (copy.name === 'encryption_client') {
          copy.settings.password = '@link_password';
          copy.settings.algorithm = '@link_algorithm';
        }
        if (copy.name === 'outbound_to_local_service') copy.settings.port = '@final_port';
        return copy;
      }),
    };

    const originPath = `cdn_inbound${
      originTls ? ' → tls_origin' : ''
    } → http_origin${useMux ? ' → mux_origin' : ''}${linkEncryption ? ' → encryption_server' : ''} → reverse_server`;

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: { 'configs/cdn-reverse-split.json': emit(iranConfig, options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: { 'configs/cdn-reverse-split.json': emit(foreignConfig, options) },
      },
      client: {
        links: [
          {
            label: 'نقطه ورود کاربران (ایران)',
            url: `${options.listenAddress === '0.0.0.0' ? options.iranHost : options.listenAddress}:${userPort}`,
            hint: 'هر سرویسی که روی این پورت گوش می‌دهد می‌تواند جلوی سرویس محلی سرور خارج قرار بگیرد.',
          },
          {
            label: 'لینک معکوس از دید سرور خارج',
            url: `${cdnAddress}:${cdnPort}`,
            hint: `سرور خارج به این آدرس وصل می‌شود و نام ${cdnHost} را در SNI و Host می‌فرستد.`,
          },
        ],
        instructions: [
          `کاربران به ${options.iranHost}:${userPort} وصل می‌شوند و خروجی‌شان ${options.localServiceAddress}:${options.finalPort} روی سرور خارج است.`,
          `سرور خارج به ${cdnAddress}:${cdnPort} وصل می‌شود، پس IP سرور ایران هیچ‌وقت لازم نیست از خارج قابل دسترسی باشد.`,
          `مسیر درخواست‌ها روی هر دو طرف ${splitPath} است و باید بایت‌به‌بایت یکسان بماند.`,
          'هر خط تونل با دو درخواست HTTP/1.1 جدا می‌رود: یک POST برای نیمه‌ی آپلود و یک GET برای نیمه‌ی دانلود.',
          originTls
            ? `TlsServer روی ایران با گواهی ${options.certPath} روی زنجیره است، پس CDN باید بتواند HTTPS را به origin ببرد.`
            : 'TlsServer روی ایران حذف شده است، یعنی CDN خودش TLS را در لبه خاتمه می‌دهد و به origin متن ساده می‌فرستد (حالت پیش‌فرض کلاودفلر و آروان‌کلاود).',
        ],
      },
      notes: [
        `جریان ترافیک: کاربر → ${options.iranHost}:${userPort} → users_inbound → Bridge ⇄ Bridge → reverse_server → ${useMux ? 'mux_origin → ' : ''}http_origin → دو درخواست HTTP/1.1 روی CDN → tls_client → http_client → ${useMux ? 'mux_client → ' : ''}reverse_client → Bridge ⇄ Bridge → ${options.localServiceAddress}:${options.finalPort}`,
        `زنجیره سمت ایران: ${originPath}`,
        'چرا split و نه websocket: در websocket یک اتصال باید تا آخر باز بماند و درخواست و پاسخ روی همان اتصال بیایند. خیلی از CDNها این را بافر می‌کنند یا بعد از چند ثانیه بی‌فعالیتی می‌بندند. در split هر نیمه یک درخواست مستقل و کوتاه است، پس CDN آن را مثل ترافیک معمولی وب می‌بیند.',
        'رابطه با XHTTP: XHTTP خودش یک transport اختصاصی Xray-core است و سمت origin باید Xray باشد، پس نسخه‌ی اصلی آن در واتروال قابل ساخت نیست. split همان ایده را با HTTP/1.1 خالص پیاده می‌کند: دو نیمه، جفت‌شدن با id مشترک، و مستقل بودن از بافر CDN.',
        'درباره‌ی padding: XHTTP برای گمراه کردن DPI مقدار تصادفی به درخواست اضافه می‌کند. در split چنین گزینه‌ای وجود ندارد و لازم هم نیست، چون شکل درخواست از قبل شبیه یک POST و یک GET معمولی است. اگر هدف مقاومت در برابر DPI سمت سرور است، padding در لایه‌ی TLS انجام می‌شود (tls13-record-shaping در TlsClient) — جایی که padding واقعاً به آن تعلق دارد.',
        'id جفت‌سازی یک راز نیست: هر اتصال یک id تصادفی ۱۲۸ بیتی می‌گیرد که صرفاً برای جفت کردن دو نیمه استفاده می‌شود. چیزی که لینک را واقعاً محافظت می‌کند رمزنگاری AEAD داخل حامل است.',
        ...(linkEncryption
          ? [
              'لایهٔ رمزنگاری داخل CDN: EncryptionServer روی ایران و EncryptionClient روی خارج، بین Mux/HTTP و ReverseServer/ReverseClient قرار می‌گیرند. CDN و هر چیزی که TLS را در لبه خاتمه دهد فقط رکوردهای AEAD را می‌بیند.',
            ]
          : []),
        'قلمرو اولویت شنونده‌ها: واتروال شنونده دارای whitelist را بر شنونده بدون فیلتر مقدم می‌داند. اگر بعداً خواستید روی همان پورت کاربران هم بیاورید، یک شنونده دیگر بدون whitelist بسازید و ترافیک خودش می‌رسد.',
        'MuxServer روی ایران و MuxClient روی خارج با هم جفت می‌شوند: MuxClient چند اتصال کاربر را جمع می‌کند و MuxServer بازشان می‌کند. ترتیب مهم است — MuxClient قبل از HttpClient و MuxServer بعد از HttpServer.',
      ],
      warnings: [
        cdnCidr.length
          ? 'whitelist پورت origin را محدود می‌کند؛ اگر IPهای خروجی CDN عوض شوند، لینک قطع می‌شود. بازه‌ها را به‌روز نگه دارید.'
          : 'لیست سفید origin خالی است، یعنی هر کسی که IP و پورت سرور ایران را پیدا کند می‌تواند به origin وصل شود و دست‌دادن را امتحان کند. IPهای خروجی CDN را در فیلد whitelist بگذارید.',
        `SNI و Host هر دو ${cdnHost} هستند. اگر دامنه در CDN پروکسی نباشد یا رکورد DNS آن به سرور ایران اشاره نکند، CDN ترافیک را به origin نمی‌رساند.`,
        'پورت origin را در فایروال سرور ایران باز کنید، ولی فقط برای بازه‌های IP خود CDN — نه برای همه.',
        'حالت split فقط با http-version = 1 کار می‌کند و با websocket جمع نمی‌شود. چون هر دو طرف مستقل انتخاب می‌کنند، هر دو باید هم‌زمان عوض شوند؛ عوض کردن یکی بدون دیگری دست‌دادن را می‌شکند.',
        'توکن مشترک split را در جای عمومی نگذارید؛ هر دو طرف باید دقیقاً همان توکن و همان نام فیلد را داشته باشند. اگر توکن را خالی بگذارید، جفت‌سازی فقط با id انجام می‌شود و هر کسی مسیر را بداند می‌تواند درخواست بفرستد.',
        'خروجی روی سرور خارج به سرویس محلی اشاره می‌کند؛ مطمئن شوید آن سرویس واقعاً گوش می‌دهد وگرنه همه اتصال‌ها بی‌صدا بسته می‌شوند.',
        'در split mode، پایان نیمه‌ی آپلود سیگنال «طرف مقابل دیگر نمی‌فرستد» است، پس اگر یکی از دو نیمه هرگز به origin نرسد لینک باز می‌ماند ولی داده‌ای عبور نمی‌کند. لاگ هر دو طرف را بعد از deploy نگاه کنید.',
        ...(linkEncryption
          ? ['رمز لینک رمزنگاری‌شده را در جای عمومی نگذارید؛ هر دو طرف باید دقیقاً همان رمز و الگوریتم را داشته باشند.']
          : []),
      ],
    };
  },
};

module.exports = [cdnReverseSplit];
