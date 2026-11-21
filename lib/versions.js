'use strict';

/**
 * WaterWall version knowledge.
 *
 * WaterWall moves fast and removes settings outright rather than deprecating
 * them: an obsolete key is a *startup error*, not a warning. A panel that
 * happily generates yesterday's config therefore produces tunnels that refuse
 * to come up, which is the worst possible failure mode.
 *
 * So the panel carries a small registry of what changed, lints every generated
 * config against it, and knows which templates need which release.
 */

/** The release this panel is written against. */
const CURRENT = '1.6.0';

/** Oldest release the panel still generates sane configs for. */
const OLDEST_SUPPORTED = '1.46.8';

// ------------------------------------------------------------------ compare

/**
 * Compare dotted version strings. Returns <0, 0 or >0.
 *
 * WaterWall versions look like "1.46.96". A plain numeric compare is wrong for
 * them: 96 > 8 must be true when the minor differs, but 8 > 96 must be true
 * within the same minor, so each component has to be compared separately and
 * only then by position.
 *
 * The project jumped from the 1.46 series to a release tagged **v1.50** whose
 * binary reports `1.5.0`. Semver order would call that older than 1.46.96, so
 * single-digit minors (1.5.x … 1.9.x) are ranked as 1.50.x … 1.90.x. There was
 * no 1.1–1.45 release (the tags start at 1.46 and move through 1.46.96), so
 * this cannot invert a real comparison, and it keeps the later series in
 * order: 1.5.42 (=1.50.42) stays older than 1.6.0 (=1.60.0).
 */
function versionParts(version) {
  const parts = String(version || '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  if (parts[0] === 1 && parts[1] >= 5 && parts[1] <= 9) return [1, parts[1] * 10, ...parts.slice(2)];
  return parts;
}

function cmp(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const gte = (a, b) => cmp(a, b) >= 0;
const lt = (a, b) => cmp(a, b) < 0;

/** Normalise user input ("v1.46.96", " 1.46.96 ") to a bare dotted string. */
function normalise(version) {
  const m = String(version || '').trim().match(/(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ registry

/**
 * Settings WaterWall no longer accepts. `since` is the release that started
 * rejecting them; `nodes` limits the lint to the relevant node types.
 *
 * A config containing any of these fails at startup with an error naming the
 * offending key, so the panel blocks it before anything is deployed.
 */
const REMOVED_SETTINGS = [
  {
    key: 'max-frame-size',
    nodes: ['RealityServer', 'RealityClient'],
    since: '1.46.96',
    reason:
      'Reality دیگر max-frame-size را نمی‌پذیرد و آن را خطای startup می‌دهد. این تنظیم فقط برای EncryptionClient/EncryptionServer معتبر است.',
    reasonEn:
      'Reality rejects max-frame-size as a startup error. The setting is only valid on EncryptionClient/EncryptionServer.',
  },
  {
    key: 'protoswap-tcp-2',
    nodes: ['IpManipulator'],
    since: '1.46.96',
    reason:
      'protoswap-tcp-2 حذف شده و کانفیگ حاوی آن رد می‌شود. از نگاشت تک‌طرفه و برگشت‌پذیر protoswap-tcp استفاده کنید.',
    reasonEn: 'protoswap-tcp-2 was removed and stale configs are rejected. Use the reversible protoswap-tcp mapping.',
  },
  {
    // Ping v1 carried a family of strategy keys; v2 accepts only the listed set.
    key: 'strategy',
    nodes: ['PingClient', 'PingServer'],
    since: '1.46.96',
    reason: 'Ping نسخه ۲ فقط local-ipv4، peer-ipv4، send-replies، identifier، sequence-start، ttl و tos را می‌پذیرد.',
    reasonEn: 'Ping v2 accepts only local-ipv4, peer-ipv4, send-replies, identifier, sequence-start, ttl and tos.',
  },
  {
    key: 'source',
    nodes: ['PingClient', 'PingServer'],
    since: '1.46.96',
    reason: 'Ping نسخه ۲ تنظیمات نسخه ۱ را رد می‌کند؛ به‌جای source از local-ipv4/peer-ipv4 استفاده کنید.',
    reasonEn: 'Ping v2 rejects v1 settings; use local-ipv4 / peer-ipv4 instead of source.',
  },
  {
    key: 'dest',
    nodes: ['PingClient', 'PingServer'],
    since: '1.46.96',
    reason: 'Ping نسخه ۲ تنظیمات نسخه ۱ را رد می‌کند؛ به‌جای dest از local-ipv4/peer-ipv4 استفاده کنید.',
    reasonEn: 'Ping v2 rejects v1 settings; use local-ipv4 / peer-ipv4 instead of dest.',
  },
  {
    key: 'mode',
    nodes: ['UdpOverTcpClient', 'UdpOverTcpServer'],
    since: '1.46.96',
    reason: 'حالت TCP از UdpOverTcp حذف شده؛ قاب‌بندی ۲ بایتی همیشه فعال است و تنظیمات باید خالی باشد.',
    reasonEn: 'TCP mode was removed from UdpOverTcp; the 2-byte framing is always active and settings must be empty.',
  },
  {
    // The single most destructive removal for this panel: a config carrying
    // `users` does not merely refuse connections, the whole core fails to
    // start, so every other tunnel on the machine goes down with it.
    key: 'users',
    nodes: ['Socks5Server', 'HttpProxyServer'],
    since: '1.46.96',
    reason:
      'آرایه users از Socks5Server و HttpProxyServer حذف شده و کانفیگ حاوی آن باعث FATAL و بالا نیامدن کل هسته می‌شود. برای احراز هویت کاربران از قالب «auth-users» استفاده کنید.',
    reasonEn:
      'The users array was removed from Socks5Server and HttpProxyServer; a config carrying it makes the whole core fail to start. Use the auth-users template for per-user credentials.',
  },
  // ---------------------------------------------------------------- 1.5.4
  {
    // 1.5.4 replaced the per-node `domain-strategy` DNS format with the shared
    // `dns-behaviour` object and rejects the legacy format outright.
    key: 'domain-strategy',
    nodes: [
      'TcpConnector',
      'TcpUdpConnector',
      'UdpConnector',
      'VlessClient',
      'TrojanClient',
      'Socks5Client',
      'HttpProxyClient',
      'ConnectionToPackets',
    ],
    since: '1.5.4',
    reason:
      'domain-strategy نود-محور در نسخه 1.5.4 حذف شد و قالب DNS قدیمی پذیرفته نمی‌شود. به‌جای آن از dns-behaviour استفاده کنید: {"resolve": false} برای عدم resolve یا {"resolve": true, "strategy": "prefer-ipv4"}.',
    reasonEn:
      'Per-node domain-strategy was removed in 1.5.4 and the legacy DNS format is not accepted. Use dns-behaviour instead: {"resolve": false} to skip resolution, or {"resolve": true, "strategy": "prefer-ipv4"}.',
  },
  // ---------------------------------------------------------------- 1.6.0
  {
    // 1.6.0: Raw output always bypasses conntrack now, and the switch that
    // used to configure it is gone.
    key: 'bypass-conntrack',
    nodes: ['RawSocket'],
    since: '1.6.0',
    reason:
      'bypass-conntrack از RawSocket حذف شده: خروجی raw در نسخه 1.6.0 همیشه از conntrack عبور می‌کند. این کلید با خطای startup رد می‌شود؛ آن را از کانفیگ حذف کنید.',
    reasonEn:
      'bypass-conntrack was removed from RawSocket in 1.6.0: raw output always bypasses conntrack now, and the key is rejected at startup. Remove it from the config.',
  },
  {
    // 1.6.0: QUIC carriers are datagram-only.
    key: 'carrier-mode',
    nodes: ['QuicClient', 'QuicServer'],
    since: '1.6.0',
    reason:
      'carrier-mode از QuicClient/QuicServer حذف شده؛ حامل‌های QUIC در نسخه 1.6.0 فقط datagram هستند. اگر QUIC روی TCP می‌خواهید از UdpOverTcpClient/Server استفاده کنید.',
    reasonEn:
      'carrier-mode was removed from QuicClient/QuicServer in 1.6.0; QUIC carriers are datagram-only. Use UdpOverTcpClient/Server pairs to carry QUIC over TCP.',
  },
  {
    // 1.6.0: Ping reuses the original IPv4 header; address rewriting and
    // header policy belong to the surrounding chain now.
    key: 'local-ipv4',
    nodes: ['PingClient', 'PingServer'],
    since: '1.6.0',
    reason:
      'local-ipv4 در نسخه 1.6.0 از Ping حذف و به‌عنوان تنظیم ناشناخته رد می‌شود؛ بازنویسی آدرس به زنجیرهٔ اطراف (مثل IpOverrider) واگذار شده است.',
    reasonEn:
      'local-ipv4 was removed from Ping in 1.6.0 and is rejected as an unknown setting; address rewriting belongs to the surrounding chain (e.g. IpOverrider).',
  },
  {
    key: 'peer-ipv4',
    nodes: ['PingClient', 'PingServer'],
    since: '1.6.0',
    reason:
      'peer-ipv4 در نسخه 1.6.0 از Ping حذف و به‌عنوان تنظیم ناشناخته رد می‌شود؛ بازنویسی آدرس به زنجیرهٔ اطراف (مثل IpOverrider) واگذار شده است.',
    reasonEn:
      'peer-ipv4 was removed from Ping in 1.6.0 and is rejected as an unknown setting; address rewriting belongs to the surrounding chain (e.g. IpOverrider).',
  },
  {
    key: 'ttl',
    nodes: ['PingClient', 'PingServer'],
    since: '1.6.0',
    reason: 'ttl و tos از Ping حذف شدند؛ سیاست هدر در زنجیرهٔ اطراف تنظیم می‌شود. تنظیمات مجاز: identifier، sequence-start و send-replies.',
    reasonEn:
      'ttl and tos were removed from Ping; header policy belongs to the surrounding chain. Allowed settings: identifier, sequence-start and send-replies.',
  },
  {
    key: 'tos',
    nodes: ['PingClient', 'PingServer'],
    since: '1.6.0',
    reason: 'ttl و tos از Ping حذف شدند؛ سیاست هدر در زنجیرهٔ اطراف تنظیم می‌شود. تنظیمات مجاز: identifier، sequence-start و send-replies.',
    reasonEn:
      'ttl and tos were removed from Ping; header policy belongs to the surrounding chain. Allowed settings: identifier, sequence-start and send-replies.',
  },
];

/**
 * Node types WaterWall removed outright. A config naming one of these does not
 * start at all (the type is unknown after startup), so the lint blocks it.
 */
const REMOVED_NODES = [
  {
    type: 'WireGuardDevice',
    since: '1.6.0',
    reason:
      'WireGuardDevice در نسخه 1.6.0 حذف شده و جای آن را WireGuardClient و WireGuardServer (با mode صریح packet یا connection) گرفته‌اند.',
    reasonEn:
      'WireGuardDevice was removed in 1.6.0 and replaced by WireGuardClient and WireGuardServer (with an explicit packet or connection mode).',
  },
  {
    type: 'TcpOverUdpClient',
    since: '1.5.4',
    reason: 'TcpOverUdpClient در نسخه 1.5.4 به KcpClient تغییر نام یافته؛ نام قدیمی شناخته نمی‌شود.',
    reasonEn: 'TcpOverUdpClient was renamed to KcpClient in 1.5.4; the old name is not recognised.',
  },
  {
    type: 'TcpOverUdpServer',
    since: '1.5.4',
    reason: 'TcpOverUdpServer در نسخه 1.5.4 به KcpServer تغییر نام یافته؛ نام قدیمی شناخته نمی‌شود.',
    reasonEn: 'TcpOverUdpServer was renamed to KcpServer in 1.5.4; the old name is not recognised.',
  },
  {
    type: 'PacketSender',
    since: '1.5.3',
    reason: 'PacketSender در نسخه 1.5.3 به PacketGenerator تغییر نام یافته است.',
    reasonEn: 'PacketSender was renamed to PacketGenerator in 1.5.3.',
  },
  {
    type: 'PacketReceiver',
    since: '1.5.3',
    reason: 'PacketReceiver در نسخه 1.5.3 به PacketCounter تغییر نام یافته است.',
    reasonEn: 'PacketReceiver was renamed to PacketCounter in 1.5.3.',
  },
];

/** Ping's complete settings allowlist as of 1.6.0, used to reject anything else. */
const PING_KEYS = new Set(['identifier', 'sequence-start', 'send-replies']);

/**
 * Features that only exist from a given release. Templates declare the ones
 * they use so the panel can tell the user to upgrade instead of deploying a
 * config the core will refuse.
 */
const FEATURES = {
  streamFragmenter: '1.46.96',
  packetsToConnection: '1.46.96',
  httpProxyClient: '1.46.96',
  realityV2: '1.46.96',
  perNodeMtu: '1.46.96',
  splice: '1.46.96',
  pingV2: '1.46.96',
  tcpTune: '1.46.96',
  ipManipulatorSni: '1.46.0',
  protoswap: '1.46.0',
  bitSwap: '1.46.0',
  // 1.5.3+
  packetCounter: '1.5.3',
  // 1.5.4+ (KCP rename, per-node DNS via dns-behaviour)
  kcp: '1.5.4',
  dnsBehaviour: '1.5.4',
  // 1.6.0+ (WireGuard split into client/server nodes)
  wireguardV2: '1.6.0',
};

/** Short human summary of what a release brought, for the UI. */
const RELEASE_NOTES = {
  '1.6.0': {
    date: '2026-11-21',
    headline: 'حامل‌های ENet و GameNetworkingSockets و RTMP و Ping6، استریپ اتصال‌ها و باطراحی WireGuard',
    headlineEn: 'ENet, GameNetworkingSockets, RTMP and Ping6 transports, connection striping and a WireGuard redesign',
    highlights: [
      'چهار حامل جدید برای استریم: EnetClient/EnetServer (ENet 1.3.18)، GnsClient/GnsServer (پروتکل GameNetworkingSockets شرکت Valve)، RtmpClient/RtmpServer (و RTMPS روی TLS) و Ping6Client/Ping6Server برای حمل پکت‌های IPv4 با قاب Echo شبیه ICMPv6.',
      'HalfDuplex مسیر آپلود و دانلود را از هم جدا می‌کند: هر جهت می‌تواند حامل مستقل خودش را داشته باشد (مثلاً TLS/TCP برای آپلود و KCP/UDP برای دانلود) و پیکربندی‌های next مشترک قبلی همچنان پشتیبانی می‌شوند.',
      'WireGuard از نو طراحی شد: WireGuardClient و WireGuardServer جایگزین WireGuardDevice شدند و سرور دو حالت صریح packet (فوروارد پکت برای peer های ثابت) و connection (احراز هویت حساب با سقف پهنای باند، حجم مصرف، محدودیت اتصال/IP، انقضا و ابطال) دارد.',
      'مسیریابی و دیتگرام: مچ کردن line-mark دقیق ۱۶ بایتی در Router، قاعده‌های negated GeoIP با پیشوند !geoip:<کشور>، حفظ مرز دیتگرام UDP در گره‌های Encryption و SpeedLimit، دیتگرام‌های خالی UDP در UdpOverTcp، و کوچک‌شدن دیتگرام‌های ACK در KCP با kcp-ack-batch.',
    ],
    breaking: [
      'WireGuardDevice حذف شد و جای آن را WireGuardClient و WireGuardServer گرفتند؛ سرور باید mode صریح packet یا connection داشته باشد و کلاینت دقیقاً یک peer سرور. قالب tun-wireguard پنل به این ساختار جدید منتقل شده است.',
      'فرمت بسته‌بندی Ping عوض شد و با نسخه قبلی ناسازگار است: head به ۹ بایت رسید و local-ipv4، peer-ipv4، ttl و tos حذف شدند — بازنویسی آدرس و سیاست هدر به زنجیرهٔ اطراف (مثل IpOverrider) واگذار شده. هر دو سمت باید هم‌زمان ارتقا یابند و بازآرایی فرگمنت قبل از Ping تنظیم شود.',
      'carrier-mode از QuicClient و QuicServer حذف شد (خارجی از دیتگرام پشتیبانی نمی‌کند) و bypass-conntrack از RawSocket حذف شد — خروجی raw همیشه از conntrack عبور می‌کند و دیگر به NAT مبتنی بر conntrack میزبان تکیه ندارد.',
      'اعتبارسنجی جدید زنجیره‌های TCP/UDP و DNS: ورودی‌های زنجیرهٔ DNS باید هم UDP و هم fallback از نوع TCP را پشتیبانی کنند. UdpStatelessSocket هم منسوخ شده و فقط هشدار startup می‌دهد (کانفیگ‌های موجود کار می‌کنند).',
    ],
  },
  '1.5.42': {
    date: '2026-11-09',
    headline: 'وصله: رفع تخصیص بیش از حد حافظهٔ کرنل برای TCP/IPv4',
    headlineEn: 'Patch: fixes excessive kernel memory allocation for TCP/IPv4',
    highlights: [
      'یک باگ در تخصیص حافظهٔ کرنل برای TCP/IPv4 باعث می‌شد سرورهای کم‌حافظه به‌سرعت حافظهٔ آزادشان را از دست بدهند؛ در این نسخه رفع شده و ارتقا به‌خصوص روی سرورهای کم‌رم توصیه می‌شود.',
    ],
    breaking: [],
  },
  '1.5.4': {
    date: '2026-11-09',
    headline: 'DNS مسیریابی‌شده، ظرفیت قابل تنظیم پشتهٔ TCP/IP و تغییر نام KCP',
    headlineEn: 'Routable DNS, configurable lwIP stack capacity and the KCP rename',
    highlights: [
      'DomainResolver سه حملهٔ DNS پیدا کرد: native (resolve با resolver مشترک کارگرها)، direct (سوالات از یک کانکتور TCP/UDP اختصاصی WaterWall می‌روند) و chain (سوالات از یک زنجیرهٔ پروکسی/تونل انتخاب‌شده عبور می‌کنند) — با fallback از UDP به TCP و بدون سقوط بی‌صدا به DNS سیستم.',
      'شیء مشترک settings.dns-behaviour روی کانکتورها، Router، کلاینت‌های پروکسی پشتیبانی‌شده، ConnectionToPackets و UdpStatelessSocket اضافه شد تا resolve محلی، انتخاب آدرس و حمل DNS به‌صورت یکنواخت تنظیم شود.',
      'پشتهٔ TCP/IP کاربرانی (lwIP) ظرفیت پذیرشی پیدا کرد: سقف‌های misc.lwip-* قابل تنظیم‌اند، پیش‌فرض جریان‌ها از ۲٬۰۴۸ به ۶۵٬۵۳۶ رسید و API فقط‌خواندنی stack-stats وضعیت حافظه و اشغالی استخرها را گزارش می‌دهد.',
      'بهبودهای انتقال: رفع کندی آپلود iOS بعد از اتلاف پکت، رفع پاسخ ناقص HTTP split و HalfDuplex، و پایداری بیشتر در QUIC و KCP.',
    ],
    breaking: [
      'TcpOverUdpClient و TcpOverUdpServer به KcpClient و KcpServer تغییر نام یافتند (همهٔ کلیدهای FEC و KCP سر جایشان‌اند)؛ قالب transport پنل به نام جدید منتقل شده و نام قدیمی اصلاً شناخته نمی‌شود.',
      'domain-strategy نود-محور حذف شد و جای آن را شیء dns-behaviour گرفت؛ قالب‌های پنل به این قالب جدید مهاجرت داده شده‌اند.',
      'ABI گره‌های خارجی عوض شد: کتابخانه‌های گرهٔ سفارشی باید با هدرهای این نسخه بازساخته شوند.',
    ],
  },
  '1.5.3': {
    date: '2026-11-05',
    headline: 'حامل پکت Fake TCP، رمزنگاری حالت packet و ده‌ها رفع اشکال پایداری',
    headlineEn: 'Fake TCP packet transport, packet-mode encryption and reliability fixes',
    highlights: [
      'گره‌های FakeTcpHeaderClient و FakeTcpHeaderServer پکت‌های کامل IPv4 را پشت یک هدر شبیه TCP (با پورت‌ها، پرچم‌ها و گزینه‌های قابل تنظیم) حمل می‌کنند و در صورت تنظیم رمز عبور مشترک، payload با XChaCha20-Poly1305 رمزنگاری می‌شود.',
      'EncryptionClient/EncryptionServer حالت packet-mode را اضافه کردند: پکت‌های کامل TCP/UDP با nonce مستقل و کلید جهت‌دار رمزنگاری می‌شوند و فقط همان پکتِ معیوب افت می‌کند، نه کل خط ارتباطی.',
      'هدایت بهتر پکت‌ها با opaque-flow-mode جدید روی TunDevice و RawSocket (پیش‌فرض prefix، به‌همراه peer، spread و auto) و صف‌بندی دسته‌ای NFQUEUE در لینوکس؛ در کنار بهبودهای SACK و بودجهٔ پنجرهٔ دریافت TCP.',
    ],
    breaking: [
      'PacketSender به PacketGenerator و PacketReceiver به PacketCounter تغییر نام یافتند (این پنل از آن‌ها استفاده نمی‌کند اما لینت آن‌ها را می‌شناسد).',
      'فرمت بسته‌بندی Ping هنوز با ۱.۶.۰ ناسازگار نبود، اما از همین نسخه تغییرات هدایت پکت چندکارگری اعمال می‌شود و تونل‌های پکتی چندکارگر باید بازبینی شوند.',
    ],
  },
  '1.5.2': {
    date: '2026-10-26',
    headline: 'انتقال بسته‌ها بین workerها، صف‌های کرنل قابل تنظیم و پیش‌فرض‌های جدید MUX',
    headlineEn: 'Packet forwarding across workers, configurable kernel queues, revised MUX admission defaults',
    highlights: [
      'PacketsToConnection و IpManipulator خودشان مالکیت flow را تعیین می‌کنند و انتقال‌های غیرضروری worker کم می‌شود',
      'TunDevice و RawSocket روی لینوکس صف‌های دریافت کرنل را خودکار tune می‌کنند (kernel-queue-tune/length/packets/receive-buffer)',
      'پیش‌فرض‌های MuxServer تغییر کرد: max-live-children=0، memory-low-watermark-percent=80، memory-reserve نصف شد',
      'پشتیبانی از VMess AEAD در نسخه 1.5.1 (TCP/UDP، AES-128-GCM و ChaCha20-Poly1305) و RawSocket multiqueue',
    ],
    breaking: [
      'ReverseClient و ReverseServer باید با هم ارتقا داده شوند',
      'AuthenticationClient و AuthenticationServer باید با هم ارتقا داده شوند',
    ],
  },
  '1.5.0': {
    date: '2026-10-23',
    headline: 'مدیریت زنده کاربران، احراز هویت مقاوم‌تر، محدودیت پهنای‌باند هر کاربر و انتقال QUIC',
    headlineEn:
      'Live user administration, resilient authentication, per-user bandwidth limits and a QUIC transport',
    highlights: [
      'نود APIServer و کلاینت پایتونی مدیریت زنده: مشاهده وضعیت، ساخت/ویرایش کاربر، رمز، سهمیه و انقضا بدون ری‌استارت',
      'AuthenticationClient در قطعی موقت سرور احراز هویت، کاربران همگام‌شده و سهمیه/انقضای آن‌ها را در حافظه نگه می‌دارد',
      'UserController محدودیت پهنای‌باند آپلود و دانلود جداگانه و تنظیم traffic-multiplier دارد',
      'TUN مالتی‌کیو، دسته‌بندی بسته‌ها، تخصیص splice وابسته به RAM و تحویل تدریجی قاب‌های MUX',
      'TlsClient از session resumption و ECH (با ech-config-list) پشتیبانی می‌کند',
      'نودهای جدید QuicClient/QuicServer روی QUIC v1 با TLS 1.3',
      'ConnectionToPackets تنظیمات target-address و port برای مقصد ثابت گرفت',
    ],
    breaking: [
      'ReverseClient و ReverseServer باید با هم ارتقا داده شوند؛ قالب معکوس روی دو نسخه مختلف بالا نمی‌آید',
      'AuthenticationClient و AuthenticationServer هم باید با هم ارتقا داده شوند',
      'UserController دستی به payload-mode نیاز دارد: stream، datagram یا dest_context->protocol',
      'آستانه pause/resume پیش‌فرض MUX حالا ۱۲۸ MiB / ۴ MiB است و UDP روی MUX قاب‌بندی صریح می‌خواهد',
      'APIServer برای هر کانفیگ بارگذاری‌شده نام منطقی یکتا و غیرخالی لازم دارد',
    ],
  },
  '1.46.96': {
    date: '2026-10-04',
    headline: 'splice در سراسر زنجیره، Mux آگاه به splice، TUN GSO/TSO و چک‌سام AVX2',
    headlineEn: 'Full-chain splice, splice-aware Mux, TUN GSO/TSO and an AVX2 checksum backend',
    highlights: [
      'splice() لینوکس در کل زنجیره‌های سازگار — داده در صف‌های کرنل می‌ماند و بین کرنل و یوزراسپیس رونویسی نمی‌شود',
      'MuxClient/MuxServer حالا با splice کار می‌کنند بدون از دست دادن قاب‌بندی MUX',
      'TUN از offloadهای virtio-net استفاده می‌کند: TUN_F_CSUM، TUN_F_TSO4 و TCPv4 GSO',
      'چک‌سام اینترنت بهینه شد؛ بک‌اند AVX2 برای CPUهای x86-64 پشتیبانی‌شده',
      'PacketsToConnection عملی شد: TunDevice → PacketsToConnection → Socks5Client → TcpUdpConnector (مثل tun2socks)',
      'نود جدید StreamFragmenter: تکه‌تکه کردن TLS ClientHello و بریدن با تأخیر، بدون نیاز به raw socket',
      'نود جدید HttpProxyClient با DNS مبدأ و پشتیبانی splice',
      'تنظیم MTU به‌ازای هر نود اضافه شد و گزینه اجرای tcp-tune در استارت آپ لینوکس',
      'Reality نسخه ۲: aes-gcm در کنار chacha20-poly1305، salt و kdf-iterations قابل تنظیم، و بازپخش‌محافظی',
    ],
    breaking: [
      'PingClient/PingServer به نسخه ۲ رفتند و با نسخه ۱ روی سیم سازگار نیستند',
      'max-frame-size در RealityServer/RealityClient خطای startup است',
      'protoswap-tcp-2 از IpManipulator حذف شد',
      'حالت TCP از UdpOverTcp حذف شد',
      'نودهای TcpListener/TcpConnector برای زنجیره‌های Mux مقادیر بافر پیش‌فرض جدیدی گرفتند',
    ],
  },
};

// ------------------------------------------------------------------ linting

/**
 * Walk a parsed node config and report settings WaterWall would reject.
 *
 * Operates on the parsed JSON *after* variable substitution, because that is
 * what the core actually parses.
 *
 * @returns {Array<{node: string, type: string, key: string, reason: string}>}
 */
function lintConfig(config) {
  const problems = [];
  const nodes = Array.isArray(config?.nodes) ? config.nodes : [];

  for (const n of nodes) {
    const settings = n?.settings;
    const type = String(n?.type || '');

    // A removed node type never reaches settings: the whole config refuses to
    // start because the type no longer exists.
    const deadType = REMOVED_NODES.find((r) => r.type === type);
    if (deadType) {
      problems.push({
        node: n?.name || type,
        type,
        key: '(node type)',
        since: deadType.since,
        reason: deadType.reason,
      });
    }

    if (!settings || typeof settings !== 'object') continue;
    // A key can be covered by both the removed list and the Ping allowlist;
    // report it once.
    const seen = new Set();

    for (const rule of REMOVED_SETTINGS) {
      if (!rule.nodes.includes(type)) continue;
      if (!(rule.key in settings)) continue;
      seen.add(rule.key);
      problems.push({
        node: n.name,
        type,
        key: rule.key,
        since: rule.since,
        reason: rule.reason,
      });
    }

    // Ping's settings are a closed set: anything outside the allowlist is
    // rejected.
    if (type === 'PingClient' || type === 'PingServer') {
      for (const key of Object.keys(settings)) {
        if (PING_KEYS.has(key) || seen.has(key)) continue;
        problems.push({
          node: n.name,
          type,
          key,
          since: '1.6.0',
          reason:
            'تنظیمات Ping یک مجموعه بسته است. از نسخه 1.6.0 فقط identifier، sequence-start و send-replies پذیرفته می‌شوند؛ بازنویسی آدرس و سیاست هدر به زنجیرهٔ اطراف واگذار شده است.',
        });
      }
    }
  }

  return problems;
}

/** Lint a config that is still text (comments and $variables$ unresolved). */
function lintText(text) {
  try {
    return lintConfig(JSON.parse(text));
  } catch {
    return []; // unparseable input is reported by the generator's own validation
  }
}

// ------------------------------------------------------------------ feature checks

/** Which of the registered features a parsed config actually relies on. */
function featuresUsed(config) {
  const used = new Set();
  const types = new Set((config?.nodes || []).map((n) => String(n?.type || '')));

  if (types.has('StreamFragmenter')) used.add('streamFragmenter');
  if (types.has('PacketsToConnection')) used.add('packetsToConnection');
  if (types.has('HttpProxyClient')) used.add('httpProxyClient');
  if (types.has('PingClient') || types.has('PingServer')) used.add('pingV2');
  if (types.has('RealityServer') || types.has('RealityClient')) used.add('realityV2');
  if (types.has('KcpClient') || types.has('KcpServer')) used.add('kcp');
  if (types.has('WireGuardClient') || types.has('WireGuardServer')) used.add('wireguardV2');
  if (types.has('PacketCounter')) used.add('packetCounter');

  for (const n of config?.nodes || []) {
    const s = n?.settings || {};
    if ('protoswap-tcp' in s || 'protoswap-udp' in s || 'protoswap' in s) used.add('protoswap');
    if ('dns-behaviour' in s) used.add('dnsBehaviour');
    if (
      'first-sni' in s ||
      'smuggle-sni' in s ||
      'overlap-sni' in s ||
      'synfin-sni' in s ||
      'sni-blender' in s ||
      'ech-sni-trick' in s
    ) {
      used.add('ipManipulatorSni');
    }
    if (n?.mtu !== undefined) used.add('perNodeMtu');
  }
  return [...used];
}

/**
 * Check a generated config against a specific WaterWall version.
 *
 * Returns problems that make the config unusable on that release.
 */
function checkAgainstVersion(config, version) {
  const v = normalise(version);
  const problems = [];

  if (!v) {
    return { known: false, version: null, problems: [], features: featuresUsed(config) };
  }

  // Removed settings matter regardless of which version: if the key exists at
  // all, the panel should never have written it.
  for (const p of lintConfig(config)) {
    problems.push({
      kind: 'removed-setting',
      node: p.node,
      key: p.key,
      message: `${p.node} (${p.type}): ${p.reason}`,
    });
  }

  const missing = [];
  for (const feature of featuresUsed(config)) {
    const since = FEATURES[feature];
    if (since && lt(v, since)) missing.push({ feature, since });
  }
  for (const m of missing) {
    problems.push({
      kind: 'too-old',
      feature: m.feature,
      message: `این کانفیگ از قابلیت «${m.feature}» استفاده می‌کند که از نسخه ${m.since} اضافه شده، ولی سرور نسخه ${v} دارد.`,
    });
  }

  return { known: true, version: v, problems, features: featuresUsed(config) };
}

/**
 * Compare a tunnel's requirements against what a server reports running.
 *
 * @param {object} template
 * @param {object|null} server  a store server record (may carry .lastStatus)
 */
function checkServer(template, server) {
  const problem = server?.lastStatus?.waterwallProblem || server?.waterwallProblem || null;
  if (problem) {
    return {
      known: false,
      reported: null,
      problems: [problem],
      message: problem.message,
    };
  }

  const reported = normalise(server?.lastStatus?.waterwallVersion || server?.waterwallVersion);
  if (!reported) {
    return {
      known: false,
      reported: null,
      problems: [],
      message: 'نسخه واتروال روی این سرور هنوز گزارش نشده — از ایجنت بخواهید وضعیت را بفرستد یا خودتان در سرور بررسی کنید.',
    };
  }

  const min = template?.minVersion || null;
  const problems = [];
  if (min && lt(reported, min)) {
    problems.push({
      kind: 'too-old',
      message: `این قالب به واتروال ${min} یا بالاتر نیاز دارد ولی روی این سرور ${reported} نصب است.`,
    });
  }
  if (lt(reported, OLDEST_SUPPORTED)) {
    problems.push({
      kind: 'unsupported',
      message: `نسخه ${reported} قدیمی‌تر از پایین‌ترین نسخه پشتیبانی‌شده پنل (${OLDEST_SUPPORTED}) است. لطفاً واتروال را به‌روز کنید.`,
    });
  }

  return { known: true, reported, problems, message: null };
}

module.exports = {
  CURRENT,
  OLDEST_SUPPORTED,
  REMOVED_SETTINGS,
  REMOVED_NODES,
  PING_KEYS,
  FEATURES,
  RELEASE_NOTES,
  cmp,
  gte,
  lt,
  normalise,
  lintConfig,
  lintText,
  featuresUsed,
  checkAgainstVersion,
  checkServer,
};