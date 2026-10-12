# پنل واتروال — WaterWall Panel

پنل وب + REST API برای ساخت، استقرار و تست تونل‌های [WaterWall](https://github.com/radkesvat/WaterWall) بین **سرور ایران** و **سرور خارج**.

هر قالب دقیقاً همان زنجیره‌ای را می‌سازد که در [مستندات رسمی](https://radkesvat.github.io/WaterWall-Docs/) توضیح داده شده — با همان کلیدهای تنظیمات، همان مقادیر مجاز و همان محدودیت‌ها.

---

## ویژگی‌ها

- **۲۲ سناریوی آماده**، دسته‌بندی‌شده: پایه، پروتکل، پروکسی، لایه ۳، عملیات
- **رابط فارسی RTL** با فرم پویا: انتخاب سناریو ← پر کردن فیلدها ← پیش‌نمایش زنده هر دو سمت
- **مولد کانفیگ** که `core.json` و `configs/*.json` را برای سرور ایران و خارج می‌سازد و **قبل از اعمال اعتبارسنجی** می‌کند
- **دو راه اعمال**: از طریق SSH، یا از طریق **ایجنت** که روی هر دو سرور اجرا می‌شود و کانفیگ را از API می‌گیرد
- **API کامل** برای مدیریت سرورها، تونل‌ها، کاربران و تست‌ها + رویدادهای زنده (SSE)
- **مدیریت کاربر** از طریق سناریوی `auth-users` که از `AuthenticationClient/Server` واتروال استفاده می‌کند
- **ابزار تست**: پورت TCP، تست سرتاسری SOCKS5، تست سرعت، پینگ، ردیابی مسیر، DNS، UDP
- **بدون هیچ وابستگی npm** — فقط Node.js 18+ و ابزارهای استاندارد سیستم

---

## راه‌اندازی سریع

```bash
node server.js
```

خروجی شامل آدرس پنل و توکن API است:

```
  UI / API : http://0.0.0.0:8787
  API token: 7942c87c6a4b98623f985396630eec465d1959c06d41dceb
```

مرورگر را باز کنید، توکن را وارد کنید.

### متغیرهای محیطی

| متغیر | پیش‌فرض | توضیح |
| --- | --- | --- |
| `WW_PANEL_PORT` | `8787` | پورت پنل |
| `WW_PANEL_HOST` | `0.0.0.0` | آدرس bind |
| `WW_PANEL_TOKEN` | تولید خودکار | توکن API |
| `WW_PANEL_DATA` | `./data` | محل ذخیره سرورها و تونل‌ها |

> **نکته امنیتی:** پنل توکن دارد ولی TLS ندارد. برای دسترسی از بیرون، پشت یک reverse proxy با HTTPS (nginx + Let's Encrypt) اجرا کنید.

---

## گردش کار

```
۱. سرورها را ثبت کنید  →  سرور ایران + سرور خارج (SSH یا Agent)
۲. سناریو را انتخاب کنید  →  فرم بر اساس همان فیلدهای مستندات واتروال
۳. پیش‌نمایش بگیرید  →  core.json و configs/*.json هر دو سمت، قبل از اعمال
۴. اعمال کنید  →  نوشتن فایل‌ها + ری‌استارت سرویس (SSH یا Agent)
۵. تست کنید  →  تست سرتاسری SOCKS5 ثابت می‌کند که کل زنجیره کار می‌کند
```

هر تغییری بعد از این مرحله، با یک کلیک روی هر دو سرور اعمال می‌شود. برای سناریوی `auth-users`، افزودن کاربر فایل `users.json` را بازنویسی می‌کند و هر دو سرور آن را دریافت می‌کنند.

---

## خانواده تونل معکوس

هر سه قالب `reverse-*` یک توپولوژی مشترک دارند و فقط لایه محافظت بین دو سرور فرق می‌کند:

```
سرور ایران:   کاربران → users_inbound ─┐
                                        ├─ Bridge ⇄ Bridge ─ reverse_server ─ [لایه محافظت] ─┐
  لینک خارج (whitelist) ───────────────────────────────────────────────────┘          │
                                                   RealityServer → dest-visitor ←────┘
سرور خارج:   reverse_client → [لایه محافظت] → tcp_to_iran
               └─ Bridge ⇄ Bridge ─ outbound_to_local_service
```

| قالب | لایه محافظت | گواهی لازم؟ |
| --- | --- | --- |
| `reverse-reality` | `RealityClient` / `RealityServer` | ❌ نه |
| `reverse-tls` | `TlsClient` / `TlsServer` | ✅ روی سرور ایران |
| `reverse-plain` | ندارد | ❌ نه |

**جریان ترافیک:** کاربر → پورت سرور ایران → لینک معکوس → سرویس محلی سرور خارج.

یعنی کاربران به **سرور ایران** وصل می‌شوند و خروجی‌شان روی **سرور خارج** است. اگر برعکسش را می‌خواهید، نقش سرورها را در پنل جابه‌جا کنید.

### چرا Reality برای این سناریو بهتر است

`RealityClient` ابتدا یک **دست‌دادن TLS واقعی** با سایت استتار انجام می‌دهد و تنها پس از موفقیت، لایه Reality فعال می‌شود. نتیجه:

- روی سرور ایران **هیچ گواهی** لازم نیست
- برای ناظر شبکه، لینک بین دو سرور شبیه یک بازدید HTTPS عادی از آن سایت است
- `verify: true` گواهی همان سایت واقعی را بررسی می‌کند، پس SNI باید در گواهی آن سایت پوشش داده شود

نود `dest-visitor` همان مقصدی است که `RealityServer.settings.destination` به آن اشاره می‌کند: بازدیدکننده‌های غیرمجاز از آنجا به سایت واقعی می‌روند.

### تنظیمات پرکاربرد

- **Same port** — هر دو شنونده روی یک پورت. واتروال شنونده‌های دارای `whitelist` را اولویت می‌دهد، پس IP سرور خارج به لینک معکوس می‌رسد و بقیه به کاربران.
- **Reverse-link whitelist** — خالی بگذارید تا IP سرور خارج به‌صورت `/32` خودکار پر شود.
- **IP استتار** — اگر DNS روی سرور ایران خراب است، IP مقصد استتار را مستقیم بدهید.
- **Minimum held connections** — تعداد اتصال زنده‌ای که سرور خارج نگه می‌دارد (پیش‌فرض ۸).

---

## سناریوی تعویض بیت‌های TCP

پیشرفته‌ترین سناریوی پنل. ترافیک کاربر به **پکت واقعی IPv4** تبدیل می‌شود و بیت‌های کنترلی TCP روی سیم جابه‌جا می‌شوند، پس دیگر شکل یک اتصال TCP واقعی ندارد. دو نسخه دارد:

| قالب | لایه Mux | خروجی روی سرور خارج |
| --- | --- | --- |
| `tcp-bit-swap` | ❌ | TUN دوم (`wtun2`) |
| `tcp-bit-swap-mux` | ✅ | یک سرویس واقعی محلی، مثلاً xray روی `127.0.0.1:2083` |

```
ایران    کاربر → users_inbound → [MuxClient] → tcp-out → TUN → IpOverrider → PacketSplitStream ─┬─ up   ─→ Obfuscator → IpManipulator → RawSocket
                                                                                                      └─ down ─→ Obfuscator → IpManipulator → RawSocket
خارج    [users_inbound → MuxServer → سرویس محلی]
         TUN دوم → IpOverrider → ObfuscatorServer → IpManipulator → RawSocket
```

در نسخه Mux، `MuxClient` قبل از تبدیل به پکت قرار می‌گیرد و روی سرور خارج یک `users_inbound` + `MuxServer` اضافه می‌شود که ترافیک را به سرویس محلی می‌رساند.

نقش هر نود:

| نود | کار |
| --- | --- |
| `TunDevice` | ساخت پکت واقعی IP از جریان کاربر |
| `IpOverrider` | جایگزینی آدرس‌های داخلی TUN با IP عمومی واقعی هر سرور |
| `PacketSplitStream` | دو شاخه `up` و `down` — **نباید** `next` داشته باشد |
| `ObfuscatorClient/Server` | XOR با کلید مشترک، برای پنهان‌کردن بایت دستکاری‌شده |
| `IpManipulator` | تعویض بیت‌های کنترلی TCP |
| `RawSocket` | تزریق و ربودن پکت خام |

### تعویض‌ها به‌صورت آینه‌ای

هر چیزی که یک طرف روی سیم می‌نویسد، طرف مقابل باید **برعکسش** بخواند:

| مسیر | نسخه ۱ (`cwr`/`rst`) | نسخه ۲ (`urg`/`ece`) |
| --- | --- | --- |
| ایران ↑ (`ip-manipulator-up`) | `psh → cwr` | `psh → urg` |
| ایران ↓ (`ip-manipulator`) | `psh → rst` | `psh → ece` |
| خارج ↗ (`ip-manipulator-in`) | `psh → cwr` | `psh → urg` |
| خارج ↘ (`ip-manipulator`) | `psh → rst` | `psh → ece` |

اگر این تبدیل‌ها آینه‌ای نباشند، تونل بی‌صدا کار نمی‌کند — نه خطایی می‌دهد، نه ترافیکی عبور می‌کند. در پنل فقط بیت‌های سمت ایران را می‌بینید و بیت‌های سمت خارج **خودکار** معکوس آن‌ها ساخته می‌شوند.

### تفاوت نسخه ۲

نسخه ۲ دو تفاوت با نسخه ۱ دارد:

1. **بیت‌های `URG`/`ECE` به‌جای `CWR`/`RST`.** بیت‌های CWR و RST معنای مستقل در TCP دارند (کاهش پنجره ازدحام و بازنشانی اتصال)، پس روی ترافیک نامرتبط دیده‌شدنی‌ترند. URG و ECE چنین بار معنایی ندارند.
2. **`packet-duplicate: 3`** روی مسیر بالا. هر پکت سه کپی به‌علاوه اصل ارسال می‌شود تا بازسازی جریان نزد ناظر مبهم شود.

### هشدارهای مهم

- **`RawSocket` به root یا `CAP_NET_ADMIN` نیاز دارد.** قاعده‌های `iptables` و `NFQUEUE` نصب می‌کند.
- **پکت‌های capture‌شده از استک شبکه میزبان حذف می‌شوند.** اگر فیلترها اشتباه باشند ممکن است ترافیک واقعی سرور قطع شود — قبل از استقرار روی سرور اصلی تست کنید.
- **IP بی‌استفاده (trash capture IP)** نباید واقعاً استفاده شود. یک رنج آدرس‌داده‌شده انتخاب کنید.
- **MTU را ۱۴۰۰ بگذارید** (نه ۱۵۰۰) چون دستکاری بیت‌ها و قالب‌بندی XOR روی اندازه پکت اثر می‌گذارد.
- **در نسخه Mux:** پورت `MuxServer` و پورت سرویس نهایی روی سرور خارج نباید عمومی باشند — فقط IP سرور ایران را در فایروال مجاز کنید.
- **در نسخه Mux:** تعداد اتصال نهایی = `per-worker-connections-count × misc.workers`. اگر `workers` زیاد باشد ممکن است از حد رابطه‌های TCP عبور کنید.
- **بسیار وابسته به مسیر است.** آنچه روی یک مسیر کار می‌کند ممکن است روی مسیر دیگر نادیده یا دور ریخته شود.

---

## سناریوها

### استتار

| قالب | توضیح |
| --- | --- |
| `tcp-bit-swap` | **تعویض بیت‌های TCP** با `RawSocket` — خروجی روی TUN دوم |
| `tcp-bit-swap-mux` | همان، به‌علاوه لایه **Mux** — خروجی روی سرویس محلی (مثلاً xray) |
| `tcp-bit-swap-mux-2` | نسخه ۲: بیت‌های `URG`/`ECE` + تکثیر پکت |
| `protoswap` | **تعویض شماره پروتکل** IPv4 — برای TCP، UDP یا هر دو |

## سناریوی تعویض شماره پروتکل

به‌جای دستکاری بیت‌های TCP، خود **شماره پروتکل در هدر IPv4** عوض می‌شود. مثلاً TCP که شماره ۶ است می‌تواند به ۵۰ تبدیل شود، پس ترافیک روی سیم دیگر TCP به نظر نمی‌رسد.

```
ایران    کاربر → users_inbound → tcp-out → TUN → IpOverrider → IpManipulator(protoswap) → ObfuscatorClient → RawSocket
خارج    TUN → IpOverrider → IpManipulator(protoswap) → ObfuscatorServer → RawSocket
```

هر دو سرور باید **دقیقاً یک شماره** داشته باشند؛ نود با دیدن شماره جایگزین خودش، پروتکل واقعی را برمی‌گرداند. چک‌سام TCP/UDP افزایشی اصلاح می‌شود و روی هر fragment هم اعمال می‌گردد، پس کار دستی لازم نیست.

### TCP، UDP یا هر دو

قالب پشتیبانی می‌کند:

| حالت | ورودی کاربران | تنظیمات |
| --- | --- | --- |
| `tcp` | `TcpListener` | `protoswap-tcp` |
| `udp` | `TcpUdpListener` | `protoswap-udp` |
| `both` | `TcpUdpListener` | هر دو، با شماره‌های متفاوت |

وقتی UDP هم تعویض می‌شود، ورودی کاربران خودکار `TcpUdpListener` می‌شود تا هر دو پروتکل روی یک پورت کار کنند.

### قواعدی که پنل قبل از تولید بررسی می‌کند

واتروال این موارد را **فقط هنگام اجرا** خطا می‌دهد، پس پنل زودتر جلویشان را می‌گیرد:

- شماره جایگزین نباید `۶` (TCP) یا `۱۷` (UDP) باشد
- اگر هر دو خانواده فعال باشند، دو شماره باید متفاوت باشند
- شماره باید بین `۰` تا `۲۵۵` باشد

## تست شماره پروتکل

**مجاز بودن یک شماره در کانفیگ کافی نیست** — ممکن است روی مسیر شما فیلتر شود. پنل یک ابزار اسکن دارد که پکت واقعی IPv4 با هر شماره می‌فرستد و گزارش می‌دهد کدام‌ها عبور می‌کنند.

ساختار پکت: هدر ۲۰ بایتی IPv4 + ۸ بایت ICMP echo request + ۸ بایت محموله که یک توکن تصادفی و شناسه `0x5741` دارد تا پاسخ‌ها قابل تفکیک باشند. هر دو checksum معتبر محاسبه می‌شوند.

نتیجه به‌صورت جدول نمایش داده می‌شود:

| شماره | وضعیت | پاسخ | تأخیر | در تونل فعلی |
| --- | --- | --- | --- | --- |
| 50 | باز | ۲ از ۲ | ۱۲ ms | ✔ |
| 132 | بسته | timeout | — | |

> **نیازمند root:** اسکن از raw socket استفاده می‌کند، پس پنل باید با `sudo` اجرا شود (یا `CAP_NET_RAW`). روی لینوکس کار می‌کند؛ روی ویندوز و مک پیام واضح برمی‌گرداند.

```bash
sudo node server.js   # برای فعال شدن تست پروتکل
```

### پایه

| قالب | زنجیره |
| --- | --- |
| `tcp-forward` | `TcpListener → TcpConnector` |
| `udp-forward` | `UdpListener → UdpConnector` |
| `tcp-udp-forward` | `TcpUdpListener → TcpUdpConnector` |
| `encrypted-tcp` | `EncryptionClient / EncryptionServer` با رمز مشترک |
| `xor-obfuscated` | `ObfuscatorClient / ObfuscatorServer` با `method: "xor"` |

### پروتکل

| قالب | زنجیره ایران | زنجیره خارج |
| --- | --- | --- |
| `vless-tls` | `Socks5Server → VlessClient → TlsClient → TcpConnector` | `TlsServer → VlessServer → TcpConnector` |
| `vless-mux-tls` | `… → MuxClient → VlessClient → TlsClient` | `TlsServer → MuxServer → VlessServer` |
| `vless-reality` | `… → VlessClient → RealityClient` | `RealityServer` (با شاخه استتار) `→ VlessServer` |
| `trojan-tls` | `… → TrojanClient → TlsClient` | `TlsServer → TrojanServer` |
| `vless-http-ws-tls` | `… → VlessClient → HttpClient → TlsClient` | `TlsServer → HttpServer → VlessServer` |
| `udp-over-tcp` | `UdpListener → UdpOverTcpClient → TlsClient` | `TlsServer → UdpOverTcpServer → UdpConnector` |

### پروکسی

| قالب | توضیح |
| --- | --- |
| `http-proxy` | `HttpProxyServer` محلی با کاربر/رمز، عبور از VLESS+TLS |
| `socks5-upstream` | خروج از طریق یک SOCKS5 دیگر (`Socks5Client`) |

### لایه ۳

| قالب | زنجیره |
| --- | --- |
| `tun-wireguard` | `TunDevice → WireGuardDevice → UdpStatelessSocket` (کلیدها درون‌چین، بدون `wg-quick`) |
| `rootless-socks-wireguard` | `TcpListener → Socks5Server → ConnectionToPackets → WireGuardDevice → UdpStatelessSocket` |
| `tun-tcp-tunnel` | `TunDevice → PacketsToStream → TlsClient` / `StreamToPackets → PacketsToConnection → TcpUdpConnector` |

### عملیات

| قالب | توضیح |
| --- | --- |
| `reverse-reality` | **تونل معکوس با Reality** — بدون گواهی، لینک بین سرورها شبیه بازدید از یک سایت واقعی |
| `reverse-tls` | تونل معکوس با TLS واقعی (نیازمند گواهی روی سرور ایران) |
| `reverse-plain` | همان توپولوژی، بدون رمزنگاری |
| `router-split` | `SniffRouter` با مسیریابی دامنه و `BlackHole` |
| `auth-users` | `AuthenticationServer` + `AuthenticationClient` روی هر دو سرور، مدیریت کاربر از پنل |
| `vless-hardened` | `SoftIpLimiter` + `SpeedLimit` + `LoggerTunnel` |
| `speedtest` | `SpeedTestClient / SpeedTestServer` (TCP یا UDP) |
| `tester-chain` | `TesterClient / TesterServer` با `KeepAlive` اختیاری |

---

## API

همه درخواست‌ها با هدر `Authorization: Bearer <token>` یا `?token=…` احراز می‌شوند.

### سرورها

```http
GET    /api/servers
POST   /api/servers
PATCH  /api/servers/:id
DELETE /api/servers/:id
GET    /api/servers/:id/probe          # اطلاعات میزبان + وضعیت سرویس
POST   /api/servers/:id/ssh            # اجرای دستور از راه دور
POST   /api/servers/:id/service        # start | stop | restart | status
```

### تونل‌ها

```http
GET    /api/tunnels
POST   /api/tunnels
GET    /api/tunnels/:id
PATCH  /api/tunnels/:id
DELETE /api/tunnels/:id
POST   /api/tunnels/:id/preview        # تولید کانفیگ بدون اعمال
POST   /api/tunnels/:id/apply          # نوشتن روی سرورها + ری‌استارت
POST   /api/tunnels/:id/regenerate     # بازتولید UUID/رمزها
POST   /api/tunnels/:id/service        # ری‌استارت سرویس هر دو سرور
GET    /api/tunnels/:id/logs?side=iran # خواندن لاگ از راه دور
GET    /api/tunnels/:id/client         # لینک‌ها و تنظیمات کلاینت
POST   /api/preview                   # پیش‌نمایش بدون ذخیره (برای فرم)
```

### کاربران (سناریوی `auth-users`)

```http
GET    /api/tunnels/:id/users
POST   /api/tunnels/:id/users          # { "username": "...", "password": "..." }
PATCH  /api/tunnels/:id/users/:username
DELETE /api/tunnels/:id/users/:username
```

### تست

```http
POST /api/test/tcp          { "host": "...", "port": 443 }
POST /api/test/socks        { "host": "...", "port": 1080 }   # سرتاسری از داخل تونل
POST /api/test/speed        { "host": "...", "port": 1080, "bytes": 8388608 }
POST /api/test/ping         { "host": "..." }
POST /api/test/traceroute   { "host": "..." }
POST /api/test/udp          { "server": "1.1.1.1" }
POST /api/test/resolve      { "host": "example.com" }
POST /api/test/protocols    { "dst": "203.0.113.9", "protocols": [50, 51, 132] }
```

### اسکن شماره پروتکل

```bash
# روی سروری که پنل با root اجرا شده
curl -X POST http://127.0.0.1:8787/api/test/protocols \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"dst":"203.0.113.9","protocols":[6,50,51,132,136,255],"timeout":1500}'
```

```json
{
  "ok": true,
  "source": "10.0.0.5",
  "destination": "203.0.113.9",
  "results": [
    { "protocol": 50, "ok": true,  "hits": 2, "attempts": 2, "latencyMs": 12, "verdict": "open" },
    { "protocol": 132, "ok": false, "hits": 0, "attempts": 2, "error": "timeout", "verdict": "blocked" }
  ],
  "summary": { "tested": 6, "open": 2, "blocked": 4, "best": 50,
               "openList": [50, 51], "blockedList": [6, 132, 136, 255] }
}
```

میان‌افزار کوتاه: `POST /api/tunnels/:id/protocol-scan` فهرست شماره‌ها را از خود تونل می‌گیرد و شماره‌های در حال استفاده را در خروجی علامت می‌زند.

### ایجنت و رویداد

```http
GET  /api/agent/config      # X-WW-Agent-Token: <token of that server>
POST /api/agent/status      # گزارش وضعیت از سمت سرور
GET  /api/events            # رویدادهای زنده (SSE)
```

### نمونه: ساخت تونل با API

```bash
curl -X POST http://127.0.0.1:8787/api/tunnels \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "main-tunnel",
    "template": "vless-reality",
    "options": { "listenPort": 1080, "publicPort": 443 }
  }'
```

```bash
# اعمال روی هر دو سرور
curl -X POST http://127.0.0.1:8787/api/tunnels/$ID/apply \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

---

## ایجنت

ایجنت روی هر دو سرور اجرا می‌شود، هر چند ثانیه کانفیگ را از پنل می‌گیرد، فایل‌ها را (با پشتیبان از نسخه قبل) می‌نویسد و سرویس را ری‌استارت می‌کند. لازم نیست پنل اتصال SSH باز نگه دارد.

توکن هر سرور در صفحه «API و ایجنت» نمایش داده می‌شود. نصب:

```bash
sudo WW_PANEL_URL="https://panel.example.com" \
     WW_AGENT_TOKEN="<token>" \
     bash install-agent.sh
```

یا مستقیم:

```bash
sudo WW_PANEL_URL="https://panel.example.com" \
     WW_AGENT_TOKEN="<token>" \
     node agent/agent.js
```

| متغیر | پیش‌فرض |
| --- | --- |
| `WW_PANEL_URL` | `http://127.0.0.1:8787` |
| `WW_AGENT_TOKEN` | الزامی |
| `WW_AGENT_INTERVAL` | `15` ثانیه |
| `WW_WATERWALL_PATH` | `/opt/waterwall` |
| `WW_SERVICE` | `waterwall` |
| `WW_STATE` | `/var/lib/ww-agent/state.json` |
| `WW_DRY_RUN` | `0` — با `1` فقط لاگ می‌کند و چیزی نمی‌نویسد |

ایجنت گزارش می‌دهد: IP عمومی، پلتفرم، تعداد هسته، وضعیت سرویس، پورت‌های در حال شنود و بار CPU.

---

## نصب واتروال روی سرور

طبق مستندات رسمی:

```bash
apt-get purge -y cmake; apt-get update
apt-get install -y snapd build-essential ninja-build ccache
snap install cmake --classic

git clone https://github.com/radkesvat/WaterWall && cd WaterWall
cmake --preset linux-gcc-x64 && cmake --build --preset linux-gcc-x64
```

سپس مسیر نصب را در پنل روی `/opt/waterwall` تنظیم کنید و یک سرویس systemd بسازید:

```ini
[Unit]
Description=WaterWall
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/waterwall
ExecStart=/opt/waterwall/WaterWall
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

---

## تست

```bash
npm test
```

هر ۲۲ قالب ساخته می‌شود، JSON تولیدی معتبر است، همه `next`ها به نود موجود اشاره می‌کنند، هر `core.json` به فایل‌هایی اشاره می‌کند که واقعاً در بسته وجود دارند، و هر دو سمت تولید می‌شوند.

---

## ساختار پروژه

```
server.js              سرور HTTP، مسیرهای API، SSE
lib/
  build.js             تانل → فایل‌های آماده + تولید رمز
  generator.js         ساخت core.json، متغیرها و اعتبارسنجی زنجیره
  store.js             ذخیره‌سازی JSON
  ssh.js               اجرای SSH / SCP
  tests.js             ابزارهای تست شبکه
  templates/
    index.js           فهرست قالب‌ها
    common.js          فیلدهای مشترک (core.json، TLS، Mux، Reality)
    basic.js           پایه
    stream.js          پروتکل
    proxy.js           پروکسی
    layer3.js          لایه ۳
    reverse.js         تونل معکوس (TLS و ساده)
    reverse-reality.js تونل معکوس با Reality
    bitswap.js         تعویض بیت‌های TCP (سه نسخه)
    protoswap.js       تعویض شماره پروتکل
    protoscan.js       ابزار تست شماره پروتکل
    ops.js             عملیات
agent/agent.js         ایجنت سمت سرور
public/                رابط کاربری
test/run-tests.js      تست‌ها
test/fake-socks.js     SOCKS5 قلابی برای تست ابزارها
```

## بلوک variables

قالب‌های `reverse-tls` و `reverse-plain` کانفیگ را با بلوک `variables` می‌سازند، درست مثل فایل‌های دستی:

```json
"variables": {
  "certificate_path": "/root/fullchain.pem",
  "ip_server_kharej": "203.0.113.9/32",
  "user_and_server_kharej_port": 443
},
"nodes": [
  { "name": "germany_reverse_tls_inbound",
    "settings": { "port": $user_and_server_kharej_port$, "whitelist": [ $ip_server_kharej$ ] } }
]
```

پنل هنگام اعتبارسنجی، همین `$name$`ها را جایگذاری و کامنت‌های `//` را حذف می‌کند — دقیقاً همان کاری که بارگذار کانفیگ واتروال انجام می‌دهد. اگر متغیرفی تعریف نشده باشد، خطا گزارش می‌شود و کانفیگ اعمال نمی‌شود.

---

## نکات مهم

- **Reality واتروال با رمز مشترک کار می‌کند، نه جفت‌کلید.** فیلد `password` بین `RealityClient` و `RealityServer` باید یکسان باشد و حداکثر ۳۲ بایت است — پنل برای همین رمز ۱۶ بایتی hex تولید می‌کند.
- **`TlsServer` به گواهی واقعی نیاز دارد.** برای سناریوهای TLS، گواهی باید از قبل روی سرور خارج موجود باشد. Reality و XOR به گواهی نیاز ندارند.
- **پورت `Socks5Server` با UDP باید `TcpUdpListener` باشد**، نه `TcpListener` — پنل این را رعایت می‌کند.
- **پکت‌ها باید کامل باشند.** `ConnectionToPackets` و `PacketsToConnection` با هر fragment ناقص خطا می‌دهند؛ MTU را روی ۱۲۸۰ نگه دارید.
- **`UdpStatelessSocket` فقط ابتدای زنجیره است** و نباید `next` نداشته باشد یا نود قبلی داشته باشد.
- **`TcpConnector` مقدار `random(x,y)` را نمی‌پذیرد**؛ این نحو فقط روی `UdpConnector` معتبر است.
- **کانفیگ‌ها را در git عمومی نگذارید** — شامل رمزها هستند.
- **در سناریوی تونل معکوس، کاربران به سرور ایران و خروجی‌شان سرور خارج است.** برعکس حالت معمول؛ اگر می‌خواهید کاربران خارج به سرویس داخل ایران برسند، باید نقش سرورها را در پنل جابه‌جا کنید.
- **رمزها یک‌بار تولید و ذخیره می‌شوند** و هر دو سمت تونل همیشه از همان مقدار استفاده می‌کنند. اگر با دکمه «بازتولید رمزها» عوضشان کنید، هر دو سرور باید هم‌زمان به‌روزرسانی شوند وگرنه لینک قطع می‌شود.
- **مقصد استتار باید یک سایت واقعی باشد.** اگر سایتی که به‌عنوان استتار انتخاب می‌کنید از ایران در دسترس نباشد یا گواهی نداشته باشد، `verify: true` دست‌دادن را رد می‌کند و کل تونل بالا نمی‌آید.

---

## پروانه

WaterWall اثر [radkesvat](https://github.com/radkesvat/WaterWall) است و تحت MPL-2.0 منتشر شده. این پنل یک ابزار کمکی مستقل است و بخشی از پروژه اصلی نیست.
