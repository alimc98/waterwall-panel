'use strict';

/**
 * CDN-fronted reverse tunnel.
 *
 * The shape this reproduces is the one people build with Backhaul's `wss`
 * transport: the foreign box dials out through a CDN to a listener that sits
 * behind it, so the listening side needs no reachable public IP of its own and
 * the link looks like ordinary HTTPS to anything watching.
 *
 *   users ─▶ CDN ─▶ Iran origin ─▶ ReverseServer ─┐
 *                                                  │ WebSocket over TLS
 *   foreign service ◀─ ReverseClient ◀─────────────┘ (through the same CDN)
 *
 * Why the CDN is in the middle rather than at the edge of the exit: an Iranian
 * box often cannot be reached directly from abroad at all — inbound filtering
 * drops the connection, and an unreachable box cannot host a reverse link. The
 * CDN is reachable from both sides, so it acts as the meeting point. Backhaul
 * spells the same idea `edge_ip`; here it is a `TcpConnector` pointed at the
 * domain or at a pinned edge address, with the domain carried in the TLS SNI
 * and the HTTP Host header.
 *
 * WaterWall has no WebSocket node. WebSocket is a mode of the HTTP transport:
 * `HttpServer` and `HttpClient` with `"websocket": true` do the opening
 * handshake and then carry the payload as WebSocket frames. That is the same
 * pair the VLESS-over-WebSocket template uses.
 */

const { CERT_PATH, KEY_PATH } = require('../certs');
const { coreFields, coreOpts, muxFields, csv, node } = require('./common');
const { emitConfig, chainConfig } = require('../generator');

const emit = (config, options) => emitConfig(config, { useVariables: options.useVariables !== false });

/** Replace concrete values with `@variables` sentinels for the tunable fields. */
function withVarSentinels(nodes, rules) {
  return nodes.map((node) => {
    const copy = JSON.parse(JSON.stringify(node));
    const fn = rules[copy.name];
    if (fn) fn(copy);
    return copy;
  });
}

/**
 * A current desktop Chrome string.
 *
 * The default in the node (`WaterWall/1.x`) announces the tunnel in a header
 * that any middlebox reads, which defeats the point of going through a CDN.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Request headers that make the opening handshake look like an XHR from a page
 * rather than a client with nothing to say. `cache-control: no-cache` also
 * keeps the CDN from serving a cached response to a tunnel request.
 */
const BROWSER_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
};

const cdnFields = [
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
      'اگر CDN خودش TLS را در لبه خاتمه دهد (حالت پیش‌فرض آروان‌کلاود)، روشن نگذارید تا TlsServer روی ایران حذف شود. اگر CDN ترافیک TLS را دست‌نخورده عبور می‌دهد یا origin protocol روی HTTPS است، روشن کنید تا گواهی روی ایران لازم شود.',
  },
  {
    key: 'httpVersion',
    group: 'cdn',
    label: 'HTTP version',
    labelFa: 'نسخه HTTP',
    type: 'select',
    default: '1.1',
    options: ['1.1', '2'],
    help:
      'وب‌سوکت روی HTTP/1.1 با GET و 101 Switching Protocols کار می‌کند. حالت ۲ به extended CONNECT نیاز دارد و بیشتر CDNها — از جمله کلاودفلر — آن را برای websocket پشتیبانی نمی‌کنند. تا وقتی مطمئن نیستید ۱.۱ را نگه دارید.',
  },
  {
    key: 'wsPath',
    group: 'cdn',
    label: 'WebSocket path',
    labelFa: 'مسیر WebSocket',
    type: 'text',
    default: '/ws',
    required: true,
    help:
      'روی هر دو طرف دقیقاً یکسان می‌شود. مسیری انتخاب کنید که با بقیه همان سایت بخورد، مثل /api/v1/stream — نه /ws.',
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
    key: 'wsOrigin',
    group: 'cdn',
    label: 'WebSocket Origin',
    labelFa: 'Origin وب‌سوکت',
    type: 'text',
    default: '',
    help:
      'اختیاری. یک مرورگر واقعی هنگام WebSocket هدر Origin می‌فرستد، پس پر کردنش طبیعی‌تر است — معمولاً https://دامنه. روی HttpServer این مقدار الزامی می‌شود، ولی هر دو طرف از همین یک فیلد ساخته می‌شوند تا هیچ‌وقت با هم نخوانند.',
  },
  {
    key: 'wsSubprotocol',
    group: 'cdn',
    label: 'WebSocket subprotocol',
    labelFa: 'زیرپروتکل وب‌سوکت',
    type: 'text',
    default: '',
    help:
      'اختیاری. اگر پر شود، روی کلاینت درخواست می‌شود و روی سرور الزامی و در پاسخ تکرار می‌شود؛ یعنی یک رمز مشترک سبک در خود دست‌دادن. خالی بگذارید تا هیچ‌کدام فرستاده نشود.',
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
];

const cdnReverseFields = [
  ...cdnFields,
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
    help: 'پورتی که CDN ترافیک را به آن می‌فرستد. همان bind_addr در کانفیگ بکهال.',
  },
  {
    key: 'listenAddress',
    group: 'entry',
    label: 'Bind address (Iran)',
    labelFa: 'آدرس bind (ایران)',
    type: 'text',
    default: '0.0.0.0',
  },
  {
    key: 'whitelist',
    group: 'entry',
    label: 'Origin whitelist (CDN egress IPs)',
    labelFa: 'لیست سفید origin (IPهای خروجی CDN)',
    type: 'list',
    default: [],
    help:
      'فقط این IPها/CIDRها اجازه رسیدن به پورت origin را دارند. واتروال شنونده دارای whitelist را بر شنونده بدون فیلتر اولویت می‌دهد، پس روی یک پورت می‌توانید دو مسیر بسازید. خالی گذاشتن یعنی هر کسی که IP سرور ایران را پیدا کند می‌تواند به origin وصل شود.',
  },
  {
    key: 'minimumUnused',
    group: 'reverse',
    label: 'Minimum held connections',
    labelFa: 'حداقل اتصال نگه‌داشته‌شده',
    type: 'number',
    default: 8,
    min: 1,
    required: true,
    help:
      'ReverseClient.minimum-unused — چند لینک معکوس آماده نگه داشته می‌شود. معادل connection_pool در بکهال. با Mux این لینک‌ها فرزند یک حامل موجودند، پس تقریباً رایگان‌اند و هزینه‌شان handshake نیست؛ ولی مرورگر یک صفحه را با چند اتصال موازی باز می‌کند، پس اگر این عدد از آن کمتر باشد اتصال‌های اضافه یک رفت‌وبرگشت منتظر می‌مانند.',
  },
  {
    key: 'reverseSecret',
    group: 'reverse',
    label: 'Shared reverse secret',
    labelFa: 'رمز مشترک لینک',
    type: 'password',
    default: '',
    help: 'اختیاری و مثل token در بکهال. اگر پر شود باید روی هر دو طرف یکسان باشد.',
  },
  {
    key: 'useMux',
    group: 'mux',
    label: 'Multiplex users over few WebSocket connections',
    labelFa: 'مالتی‌پلکس کاربران روی چند اتصال WebSocket',
    type: 'boolean',
    default: true,
    help:
      'چند صد اتصال کاربر روی چند اتصال HTTP جمع می‌شود. برای CDN مهم است: تعداد اتصال هم‌زمان و نرخ handshake را کم می‌کند و هر اتصال تازه هزینه TLS و یک رکورد در لاگ CDN دارد.',
  },
  ...muxFields(),
  {
    key: 'domain',
    group: 'tls',
    label: 'Domain for an automatic certificate (Iran)',
    labelFa: 'دامنه برای ساخت خودکار گواهی (ایران)',
    type: 'text',
    default: '',
    when: { originTls: true },
    help:
      'فقط وقتی معنی دارد که «اتصال CDN به origin روی TLS» روشن باشد. معمولاً همان دامنه‌ی CDN است و گواهی باید روی سرور ایران ساخته شود.',
  },
  {
    key: 'certMode',
    group: 'tls',
    label: 'How to obtain the certificate',
    labelFa: 'روش تهیه گواهی',
    type: 'select',
    default: 'auto',
    options: ['auto', 'letsencrypt', 'self-signed', 'none'],
    when: { originTls: true },
    help: "auto: اگر دامنه به IP سرور ایران اشاره کند از Let's Encrypt می‌گیرد، وگرنه خودامضا می‌سازد.",
  },
  {
    key: 'certEmail',
    group: 'tls',
    label: "Email for Let's Encrypt",
    labelFa: 'ایمیل برای Let\'s Encrypt',
    type: 'text',
    default: '',
    when: { originTls: true },
  },
  {
    key: 'certPath',
    group: 'tls',
    label: 'Certificate path (Iran)',
    labelFa: 'مسیر گواهی (ایران)',
    type: 'text',
    default: CERT_PATH,
    required: true,
    when: { originTls: true },
    help: 'TlsServer.cert-file روی سرور ایران.',
  },
  {
    key: 'keyPath',
    group: 'tls',
    label: 'Private key path (Iran)',
    labelFa: 'مسیر کلید (ایران)',
    type: 'text',
    default: KEY_PATH,
    required: true,
    when: { originTls: true },
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
    help: 'خروجی ترافیک کاربران به این آدرس روی سرور خارج می‌رود (مثلاً یک xray محلی).',
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
    help: 'پورت پیش‌فرض ۸۰۸۰ است تا با وب‌سرور خود سرور خارج تصادم نکند.',
  },
  {
    key: 'useVariables',
    group: 'advanced',
    label: 'Use $variables$ in the config',
    labelFa: 'استفاده از متغیرها در کانفیگ',
    type: 'boolean',
    default: true,
    help: 'مقادیر قابل تنظیم در بلوک variables بالای فایل قرار می‌گیرند، مثل کانفیگ‌های دستی.',
  },
  ...coreFields(),
];

const cdnReverseWss = {
  id: 'cdn-reverse-wss',
  title: 'Reverse tunnel over WebSocket + TLS behind a CDN',
  titleFa: 'تونل معکوس WebSocket + TLS پشت CDN',
  category: 'ops',
  categoryFa: 'عملیات',
  icon: '☁️',
  sides: ['iran', 'foreign'],
  summary:
    'Iran: TcpListener(origin) -> [TlsServer] -> HttpServer(websocket) -> [MuxServer] -> ReverseServer -> Bridge ⇄ Bridge <- TcpListener(users).  Foreign: TcpConnector -> TlsClient -> HttpClient(websocket) -> [MuxClient] -> ReverseClient -> Bridge ⇄ Bridge -> local service.  The foreign box dials in through the CDN, so the Iran box needs no reachable inbound path of its own.',
  summaryFa:
    'سرور ایران پشت CDN می‌نشیند و سرور خارج از طریق همان CDN به آن وصل می‌شود؛ لینک به شکل WebSocket روی HTTPS است. مناسب وقتی IP سرور ایران از خارج قابل دسترسی نیست و باید از داخل ایران هم سریع بماند.',
  docs: 'https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/HttpServer',
  tags: ['cdn', 'websocket', 'wss', 'reverse', 'tls', 'mux', 'arvancloud', 'backhaul'],
  // Every exit dials the same CDN hostname, so any number of them can share the
  // entry; the origin only sees the CDN, not the individual exit servers.
  multiExit: true,
  clientHint:
    'کاربران به پورت سرور ایران وصل می‌شوند؛ خروجی ترافیک آن‌ها سرویس محلی روی سرور خارج است. لینک معکوس از داخل CDN عبور می‌کند.',
  fields: cdnReverseFields,

  build({ options }) {
    const userPort = Number(options.userPort) || 443;
    const originPort = Number(options.originPort) || 8443;
    const cdnPort = Number(options.cdnPort) || 443;
    const cdnHost = String(options.cdnHost || '').trim() || 'cdn.example.com';
    const originTls = options.originTls === true;
    const useMux = options.useMux !== false;
    const httpVersion = String(options.httpVersion || '1.1') === '2' ? '2' : '1.1';
    // ALPN and the HTTP mode are chosen independently by the two nodes and are
    // never reconciled at runtime, so they have to be derived from one value
    // here. A WebSocket upgrade is HTTP/1.1 and requires "http/1.1".
    const alpn = httpVersion === '2' ? 'h2' : 'http/1.1';
    const wsPath = String(options.wsPath || '/ws');
    const cdnAddress = String(options.edgeAddress || '').trim() || cdnHost;
    const expectedHost = String(options.expectedHost || '').trim();
    const cdnCidr = csv(options.whitelist);

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

    // The opening handshake, identical on both sides for everything the peer
    // checks. `websocket-origin` and `websocket-subprotocol` are *required*
    // values on HttpServer when set, so they are only emitted when the client
    // will actually send them — an empty client field against a required server
    // field is a handshake that always fails.
    //
    // `host` is deliberately not in here. On the client it must stay the CDN
    // domain, because that is what the CDN routes on; only the origin gets to
    // require a particular Host.
    const handshake = {};
    if (String(options.wsOrigin || '').trim()) handshake['websocket-origin'] = String(options.wsOrigin).trim();
    if (String(options.wsSubprotocol || '').trim()) {
      handshake['websocket-subprotocol'] = String(options.wsSubprotocol).trim();
    }

    const httpServerSettings = {
      'http-version': httpVersion,
      path: wsPath,
      method: 'GET',
      status: 200,
      websocket: true,
      ...(expectedHost ? { host: expectedHost } : {}),
      ...handshake,
    };

    const httpClientSettings = {
      host: cdnHost,
      path: wsPath,
      scheme: 'https',
      port: cdnPort,
      method: 'GET',
      'http-version': httpVersion,
      websocket: true,
      'user-agent': options.userAgent || DEFAULT_USER_AGENT,
      headers: { ...BROWSER_HEADERS },
      ...handshake,
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
    if (useMux) {
      iranNodes.push(node('mux_origin', 'MuxServer', { 'max-children': maxChildren }, 'reverse_server'));
    }
    iranNodes.push(
      node('http_origin', 'HttpServer', httpServerSettings, useMux ? 'mux_origin' : 'reverse_server'),
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
      name: 'iran-cdn-reverse-server',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(options.useVariables !== false
        ? {
            variables: {
              cdn_domain: cdnHost,
              cdn_port: cdnPort,
              origin_port: originPort,
              users_inbound_port: userPort,
              ...(originTls ? { certificate_path: options.certPath, key_path: options.keyPath } : {}),
            },
          }
        : {}),
      nodes: withVarSentinels(iranNodes, {
        cdn_inbound: (n) => {
          n.settings.port = '@origin_port';
        },
        users_inbound: (n) => {
          n.settings.port = '@users_inbound_port';
        },
        tls_origin: (n) => {
          n.settings['cert-file'] = '@certificate_path';
          n.settings['key-file'] = '@key_path';
        },
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
      node('reverse_client', 'ReverseClient', clientReverse, useMux ? 'mux_client' : 'http_client'),
    ];
    if (useMux) {
      foreignNodes.push(node('mux_client', 'MuxClient', muxClientSettings, 'http_client'));
    }
    foreignNodes.push(node('http_client', 'HttpClient', httpClientSettings, 'tls_client'));
    foreignNodes.push(
      node('tls_client', 'TlsClient', { sni: cdnHost, verify: options.verify !== false, alpns: [alpn] }, 'tcp_to_cdn'),
    );
    foreignNodes.push(node('tcp_to_cdn', 'TcpConnector', { address: cdnAddress, port: cdnPort, nodelay: true }));

    const foreignConfig = {
      name: 'foreign-cdn-reverse-client',
      author: 'waterwall-panel',
      'config-version': 1,
      'core-minimum-version': 0,
      encrypted: false,
      ...(options.useVariables !== false
        ? {
            variables: {
              cdn_domain: cdnHost,
              cdn_port: cdnPort,
              ip_cdn_or_edge: cdnAddress,
              final_port: Number(options.finalPort) || 8080,
              min_held_connections: Number(options.minimumUnused) || 8,
            },
          }
        : {}),
      nodes: withVarSentinels(foreignNodes, {
        tcp_to_cdn: (n) => {
          n.settings.address = '@ip_cdn_or_edge';
          n.settings.port = '@cdn_port';
        },
        tls_client: (n) => {
          n.settings.sni = '@cdn_domain';
        },
        reverse_client: (n) => {
          n.settings['minimum-unused'] = '@min_held_connections';
        },
        outbound_to_local_service: (n) => {
          n.settings.port = '@final_port';
        },
      }),
    };

    const originPath = originTls
      ? `cdn_inbound → tls_origin → http_origin${useMux ? ' → mux_origin' : ''} → reverse_server`
      : `cdn_inbound → http_origin${useMux ? ' → mux_origin' : ''} → reverse_server`;

    return {
      iran: {
        core: coreOpts(options, { ramProfile: 'server' }),
        files: { 'configs/cdn-reverse-wss.json': emit(iranConfig, options) },
      },
      foreign: {
        core: coreOpts(options, { ramProfile: 'client' }),
        files: { 'configs/cdn-reverse-wss.json': emit(foreignConfig, options) },
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
          `مسیر WebSocket روی هر دو طرف ${wsPath} است و باید بایت‌به‌بایت یکسان بماند.`,
          originTls
            ? `TlsServer روی ایران با گواهی ${options.certPath} روی زنجیره است، پس CDN باید بتواند HTTPS را به origin ببرد.`
            : 'TlsServer روی ایران حذف شده است، یعنی CDN خودش TLS را در لبه خاتمه می‌دهد و به origin متن ساده می‌فرستد (حالت پیش‌فرض آروان‌کلاود).',
        ],
      },
      notes: [
        `جریان ترافیک: کاربر → ${options.iranHost}:${userPort} → users_inbound → Bridge ⇄ Bridge → reverse_server → ${useMux ? 'mux_origin → ' : ''}http_origin → لینک WebSocket روی CDN → tls_client → http_client → ${useMux ? 'mux_client → ' : ''}reverse_client → Bridge ⇄ Bridge → ${options.localServiceAddress}:${options.finalPort}`,
        `زنجیره سمت ایران: ${originPath}`,
        'چرا CDN لازم است: IP سرور ایران معمولاً از خارج قابل دسترسی نیست، پس سرور خارج نمی‌تواند مستقیم به آن وصل شود. CDN از هر دو طرف در دسترس است و نقطه دیدار می‌شود — همان کاری که edge_ip در بکهال می‌کند.',
        'WebSocket در واتروال نود جداگانه ندارد؛ حالت websocket در HttpServer و HttpClient است. ALPN و نسخه HTTP توسط دو نود مستقل انتخاب می‌شوند و در runtime با هم تطبیق داده نمی‌شوند، برای همین هر دو از یک فیلد مشترک ساخته می‌شوند.',
        'قلمرو اولویت شنونده‌ها: واتروال شنونده دارای whitelist را بر شنونده بدون فیلتر مقدم می‌داند. اگر بعداً خواستید روی همان پورت کاربران هم بیاورید، یک شنونده دیگر بدون whitelist بسازید و ترافیک خودش می‌رسد.',
        'MuxServer روی ایران و MuxClient روی خارج با هم جفت می‌شوند: MuxClient چند اتصال کاربر را روی چند WebSocket جمع می‌کند و MuxServer بازشان می‌کند. ترتیب مهم است — MuxClient قبل از HttpClient و MuxServer بعد از HttpServer.',
      ],
      warnings: [
        cdnCidr.length
          ? 'whitelist پورت origin را محدود می‌کند؛ اگر IPهای خروجی CDN عوض شوند، لینک قطع می‌شود. بازه‌ها را به‌روز نگه دارید.'
          : 'لیست سفید origin خالی است، یعنی هر کسی که IP و پورت سرور ایران را پیدا کند می‌تواند به origin وصل شود و دست‌دادن را امتحان کند. IPهای خروجی CDN را در فیلد whitelist بگذارید.',
        `SNI و Host هر دو ${cdnHost} هستند. اگر دامنه در CDN پروکسی نباشد یا رکورد DNS آن به سرور ایران اشاره نکند، CDN ترافیک را به origin نمی‌رساند.`,
        'پورت origin را در فایروال سرور ایران باز کنید، ولی فقط برای بازه‌های IP خود CDN — نه برای همه.',
        'عددهای مذاکره باید با هم بخوانند: http-version روی هر دو طرف یکی است و alpns هم از همان ساخته می‌شود. تغییر یکی بدون دیگری دست‌دادن را می‌شکند.',
        'خروجی روی سرور خارج به سرویس محلی اشاره می‌کند؛ مطمئن شوید آن سرویس واقعاً گوش می‌دهد وگرنه همه اتصال‌ها بی‌صدا بسته می‌شوند.',
        'اگر CDN درخواست‌های طولانی دوطرفه را بافر کند، حالت websocket ممکن است پاسخ ندهد. راه‌حل، حالت http1-mode: split در HttpServer و HttpClient است که آپلود و دانلود را به دو درخواست جدا می‌شکند — ولی با websocket جمع نمی‌شود و باید هر دو طرف هم‌زمان عوض شوند.',
      ],
    };
  },
};

module.exports = [cdnReverseWss];
