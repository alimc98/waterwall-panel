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

### ورود SSH: کلید یا sshpass

پنل برای رسیدن به سرورها از `ssh` و `scp` خود سیستم استفاده می‌کند و ورود با **رمز** روی `sshpass` سوار است که فقط روی لینوکس و مک وجود دارد. پس:

| پنل روی | راه درست |
| --- | --- |
| لینوکس / مک | رمز کار می‌کند اگر `sshpass` نصب باشد، وگرنه کلید |
| ویندوز | **فقط کلید** — `sshpass` برای ویندوز وجود ندارد |

روی ویندوز یک کلید بسازید و در تنظیمات سرور در فیلد «مسیر کلید SSH» بگذارید، و فیلد رمز را **خالی** کنید:

```powershell
ssh-keygen -t ed25519 -N '""' -f .\data\panel-ssh-key
ssh-copy-id -i .\data\panel-ssh-key.pub root@SERVER_IP
```

فیلد رمز مهم است خالی بماند: تا وقتی رمزی ذخیره شده باشد، پنل `sshpass` را ترجیح می‌دهد و روی ویندوز هر deploy با یک خطای نامفهوم برمی‌گردد. خود پنل این حالت را تشخیص می‌دهد و به‌جای `spawn sshpass ENOENT` می‌گوید دقیقاً چه کار کنید.

## گواهی TLS خودکار

بیشتر قالب‌های TLS به گواهی نیاز دارند و تا الان تنها راه، نصب دستی روی سرور بود. حالا فرم تونل یک فیلد **دامنه** دارد و پنل هنگام اعمال خودکار گواهی را صادر می‌کند.

```
فرم تونل:  دامنه ▸ certMode=auto ▸ اعمال
              ↓
پنل:  آیا گواهی معتبر برای این دامنه هست؟
        └── بله، و بیش از ۳۰ روز اعتبار دارد  →  همان را استفاده کن
        └── خیر یا نزدیک انقضا                   →  صادر یا تمدید کن
              ↓
سرور: /etc/waterwall/cert/{fullchain.pem, privkey.pem}
              ↓
کانفیگ نوشته می‌شود و سرویس ری‌استارت می‌شود
```

### سه روش

| روش | چه می‌کند | چه زمانی کار می‌کند |
|---|---|---|
| `auto` | اگر دامنه به IP سرور اشاره کند Let's Encrypt می‌گیرد، وگرنه خودامضا | همیشه به جایی می‌رسد |
| `letsencrypt` | فقط CA واقعی؛ در صورت شکست **خطا می‌دهد** | دامنه واقعی + پورت ۸۰ باز |
| `self-signed` | فقط گواهی خودامضا | همیشه |

`auto` به‌جای شکست، بی‌سروصدا به خودامضا برمی‌گردد و **علت** را در پاسخ اعمال می‌نویسد، تا یک DNS تنظیم‌نشده باعث قطع تست نشود.

### پیش‌نیازهای Let's Encrypt

پنل این‌ها را قبل از تلاش بررسی می‌کند و پیام روشن می‌دهد:

- رکورد A دامنه باید به IP عمومی همان سرور اشاره کند
- پورت ۸۰ روی آن سرور از اینترنت باز باشد (چالش http-01)
- `certbot` نصب باشد (پنل در صورت نبود نصبش می‌کند)

اگر یکی برقرار نباشد، یکی از این‌ها برمی‌گردد:

| وضعیت | پیام |
|---|---|
| دامنه resolve نمی‌شود | دامنه از سرور قابل resolve نیست |
| دامنه به IP دیگری اشاره دارد | دامنه به `1.2.3.4` اشاره می‌کند ولی IP این سرور `5.6.7.8` است |
| چالش نرسید | چالش http-01 از اینترنت به پورت ۸۰ نرسید |

### گواهی روی کدام سرور؟

پنل کانفیگ تولیدشده را می‌خواند و گواهی را روی سروری می‌گذارد که **واقعاً `TlsServer`** دارد:

| قالب | سرورگواهی |
|---|---|
| بیشتر قالب‌ها (VLESS، Trojan، XOR …) | خارج |
| `reverse-tls`، `reverse-reality` | ایران |

این تفکیک با تست واقعی پیدا شد: تونل معکوس سمت سرور TLS را برعکس دارد.

### وضعیت نامعتبر بودن دامنه ورودی

مقدار دامنه داخل `openssl -subj` و برای Let's Encrypt داخل **خط فرمان سرور** قرار می‌گیرد، پس قبل از هر کاری اعتبارسنجی می‌شود:

```
✔ example.com                    ✔ auto.example.org
✘ example.com; rm -rf /          ✘ $(whoami)
✘ -bad.com                       ✘ exam ple.com   ← عمداً رد می‌شود
✘ example..com                      (فاصله تایپو است، نه چیزی که
✘ مثال ارسالی                       بی‌سروصدا اصلاح شود)
```

فاصله‌ی داخلی عمداً **حذف نمی‌شود**: تایپوی `exam ple.com` بی‌صروصدا به `example.com` تبدیل می‌شد و باعث صدور گواهی برای دامنه‌ای می‌شد که کاربر هرگز ننوشته.

### صفحه گواهی‌ها

صفحه **گواهی‌ها** وضعیت زنده هر سرور را نشان می‌دهد — از خود سرور خوانده می‌شود، نه از حافظه پنل:

| ستون | منبع |
|---|---|
| وضعیت | `valid` / `expiring` / `expired` — از تاریخ انقضای واقعی |
| دامنه | CN گواهی روی دیسک |
| انقضا | تاریخ واقعی |
| اثر انگشت | SHA-256 گواهی نصب‌شده |

گواهی تا **۳۰ روز** مانده به انقضا که `expiring` می‌شود و در اعمال بعدی خودکار تمدید می‌شود.

### API

```bash
# وضعیت همه سرورها (خوانده زنده)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/certs

# صدور روی یک سرور مشخص
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"domain":"example.com","mode":"auto","role":"foreign"}' \
  http://127.0.0.1:8787/api/certs

# هنگام اعمال تونل، گواهی خودکار گرفته می‌شود
# و نتیجه در پاسخ apply می‌آید:
#   { "certificate": { "mode": "letsencrypt", "domain": "example.com", ... } }

# خاموش کردن مسیر خودکار برای یک تونل
curl -X POST ... -d '{"checkCertificates": false}' /api/tunnels/ID/apply
```

> فایل گواهی هرگز به پنل برنمی‌گردد. کلید خصوصی همان‌جا که ساخته شده می‌ماند.

## نصب روی سرور

### خودکار (دسترسی به گیت‌هاب)

```bash
curl -fsSL https://raw.githubusercontent.com/alimc98/waterwall-panel/main/install.sh | sudo bash -s -- \
  --panel-url https://panel.example.com \
  --agent-token AGENT_TOKEN
```

اسکریپت معماری CPU را تشخیص می‌دهد، باینری مناسب را از گیت‌هاب می‌گیرد، یونیت systemd و ایجنت را می‌نویسد و sysctl را تنظیم می‌کند.

### آفلاین (بدون دسترسی به گیت‌هاب)

اگر ارتباط سرور ایران با خارج قطع شده و سرور به گیت‌هاب دسترسی ندارد:

```bash
# 1) روی کامپیوتر خودتان فایل‌ها را بگیرید:
#      Waterwall-linux-gcc-x64-old-cpu.zip
#      agent.js
scp Waterwall-linux-gcc-x64-old-cpu.zip agent.js root@SERVER_IP:/root/

# 2) روی سرور:
sudo ./install.sh --offline \
  --waterwall-zip /root/Waterwall-linux-gcc-x64-old-cpu.zip \
  --agent-file /root/agent.js \
  --panel-url https://panel.example.com \
  --agent-token AGENT_TOKEN
```

هیچ درخواستی به شبکه زده نمی‌شود. همان فایل zip و همان ایجنت نصب می‌شوند.

### کاملاً دستی

راهنمای گام‌به‌گام بدون هیچ اسکریپتی — ساخت باینری، یونیت systemd، sysctl و عیب‌یابی:

**[docs/INSTALL-MANUAL.md](docs/INSTALL-MANUAL.md)**

### ⚠️ نام باینری

آرشیو انتشار رسمی باینری را **`Waterwall`** می‌نامد (حرف w کوچک)، در حالی که خود مخزن `WaterWall` است. روی لینوکس مسیر به حروف حساس است — یک اشتباه کوچک باعث `ExecStart` شکسته می‌شود.

پنل هر دو نام را می‌پذیرد، ولی اسکریپت و سند نصب از `Waterwall` استفاده می‌کنند.

### گزینه‌های `install.sh`

| گزینه | توضیح |
| --- | --- |
| `--panel-url URL` | آدرس پنل که ایجنت آن را poll می‌کند |
| `--agent-token TOKEN` | توکن ایجنت این سرور |
| `--version VER` | نسخه واتروال (پیش‌فرض `1.46.96`) |
| `--base DIR` | مسیر نصب (پیش‌فرض `/opt/waterwall`) |
| `--arch ARCH` | `x64` \| `x64-old` \| `arm64` \| `arm64-old` \| `clang` \| `avx512` |
| `--waterwall-zip FILE` | نصب از فایل محلی |
| `--agent-file FILE` | نصب ایجنت از فایل محلی |
| `--offline` | هیچ درخواست شبکه‌ای |
| `--skip-waterwall` | فقط ایجنت |
| `--skip-agent` | فقط واتروال |
| `--skip-tuning` | دست‌نزدن به sysctl |
| `--force` | بازنویسی نصب موجود |

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

## بررسی دسترسی بعد از اعمال

یک تونل ممکن است **بی‌نقص آپلود شود و باز هم کار نکند**، چون فایروال هرگز پورت لینک را باز نکرده است. این رایج‌ترین حالتی است که کاربر می‌گوید «اعمال شد ولی چیزی کار نمی‌کند».

پنل بعد از اعمال، هر دو جهت را **واقعاً** تست می‌کند — نه اینکه فقط فایل‌ها را نوشته باشد:

```
ایران ──── پورت لینک ────→ خارج      (لینک بین دو سرور)
خارج ──── پورت کاربران ──→ ایران      (ورودی کاربران)
```

### طبقه‌بندی نتیجه

پورت‌ها با کد خروجی `timeout` تشخیص داده می‌شوند، نه با اینکه «آیا خطا داد»:

| کد خروجی | وضعیت | معنی |
| --- | --- | --- |
| `0` | **باز** | اتصال پذیرفته شد |
| `124` | **فیلترشده** | بسته‌ای برنگشت — کسی آن را گرفت |
| هر چیز دیگر | **بسته** | میزبان RST فرستاد، چیزی گوش نمی‌دهد |

اگر ایران حتی به پورت ۲۲ خارج وصل نشود، نتیجه‌ی پورت لینک **بی‌معنا** است. پنل در این حالت به‌جای گزارش «فیلترشده»، یک کنترل روی پورت ۲۲ اجرا می‌کند و می‌گوید:

> سرور ایران حتی به پورت ۲۲ سرور خارج وصل نمی‌شود، پس نتیجه پورت لینک بی‌معنی است.

این تفکیک مهم است: «پورت لینک فیلتر شده» و «کل مسیر شبکه ایران خراب است» دو مشکل کاملاً متفاوت‌اند و هرکدام راه‌حل دیگری دارد.

### رفع با یک کلیک

وقتی فایروال مشکل را ساخته باشد، پنل **خود قانون را پیشنهاد می‌دهد و دکمه اعمال دارد**:

```bash
ufw allow from 31.171.100.216 to any port 2053 proto tcp   # لینک: فقط از IP ایران
ufw allow 443/tcp                                          # ورودی کاربران
```

دکمه ⚡ فقط برای قانونی ظاهر می‌شود که **خود پنل استخراج کرده** — نه متنی که کاربر تایپ کند. سمت سرور هم قانون دوباره بر اساس شکل بررسی می‌شود:

```js
/^ufw allow from \S+ to any port \d{1,5} proto (tcp|udp)$/
/^ufw allow \d{1,5}\/(tcp|udp)$/
```

هر چیزی خارج از این دو الگو رد می‌شود. یعنی `ufw disable`، `ufw --force delete all`، `iptables -F` و `rm -rf /` هرگز اجرا نمی‌شوند — حتی اگر کسی مستقیم endpoint را صدا بزند.

> دامنه لینک عمداً **به دنیا باز نمی‌شود**. پورت لینک فقط یک همتا دارد، و «باز کردن برای همه» گزینه درستی برای کسی نیست که همین حالا دارد فایروال را درست می‌کند.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"command":"ufw allow from 31.171.100.216 to any port 2053 proto tcp"}' \
  http://127.0.0.1:8787/api/tunnels/ID/fix-firewall
```

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

## تونل معکوس پشت CDN

قالب `cdn-reverse-wss` همان کاری را می‌کند که بکهال با `transport = "wss"` و `edge_ip` انجام می‌دهد، ولی روی واتروال:

```
کاربران → CDN (آروان) ─→ سرور ایران:origin_port ─ [TlsServer] ─ HttpServer(websocket)
                                                                    └─ [MuxServer] ─ reverse_server
                              users_inbound ─ Bridge ⇄ Bridge ──────────┘
سرور خارج:  tcp_to_cdn → CDN → TlsClient → HttpClient(websocket) → [MuxClient] → reverse_client
              └─ Bridge ⇄ Bridge ─ outbound_to_local_service
```

### چرا CDN وسط است، نه لبه

IP سرور ایران در عمل از خارج قابل دسترسی نیست — فیلتر ورودی اتصال را می‌اندازد، و سروری که از بیرون دیده نمی‌شود نمی‌تواند میزبان لینک معکوس باشد. CDN از **هر دو طرف** در دسترس است، پس نقطه دیدار می‌شود:

- کاربران داخل ایران به CDN (داخلی، سریع، فیلترنشده) وصل می‌شوند
- سرور خارج هم به همان CDN وصل می‌شود، پس لازم نیست IP سرور ایران هیچ‌وقت از خارج قابل دسترسی باشد

همین ایده در بکهال `edge_ip` نام دارد. معادلش در اینجا `TcpConnector` روی دامنه یا IP لبه است، با دامنه در SNI و هدر Host.

### نگاشت تنظیمات بکهال به واتروال

| بکهال | واتروال در این قالب |
| --- | --- |
| `[server] bind_addr` | `originPort` روی `cdn_inbound` |
| `tls_cert` / `tls_key` | `certPath` / `keyPath` روی `tls_origin` (فقط اگر `originTls` روشن باشد) |
| `transport = "wss"` | `HttpServer` / `HttpClient` با `websocket: true` |
| `token` | `reverseSecret` روی `ReverseServer` و `ReverseClient` |
| `connection_pool` | `minimumUnused` روی `ReverseClient` |
| `edge_ip` | `edgeAddress` روی `TcpConnector` کلاینت |
| `ports` (سمت سرور) | `users_inbound` روی سرور ایران |
| `nodelay = true` | `nodelay: true` روی همه شنونده‌ها و اتصال‌ها |

### نکته‌ای که موقع ساخت پیدا شد

قواعد چیدمان `Bridge` در مستندات صریح است:

- `ReverseServer.next` باید **مستقیم** به `Bridge` برسد و `Bridge.next` باید **مستقیم** به `ReverseClient` برسد؛ هیچ نودی در این فاصله مجاز نیست.
- اما یک `Bridge` داخل جفت **نباید `next` داشته باشد**. چون `settings.pair` خودش دو گره را به هم می‌بندد، اگر گره سومی `next`اش همان شریک باشد، واتروال فایل را بار نمی‌کند:

```
FATAL Node Map Failure: Node (bridge_reverse_side) wanted to bind to (bridge_user_side)
                        which is already bounded by bridge_reverse_side
```

پنل این حالت را حالا قبل از استقرار می‌گیرد (`validateBundle`)، ولی اگر کانفیگ را دستی می‌نویسید یادتان باشد.

### پورت origin با پورت کاربران فرق دارد

این دو تا مستقل از هم‌اند و اشتباه گرفتنشان دقیقاً همان چیزی است که تونل را بی‌صدا خراب می‌کند:

| | کجا تنظیم می‌شود | به چه کار می‌آید |
| --- | --- | --- |
| `originPort` | پنل CDN → `origin protocol` و پورت origin | CDN ترافیک را به این پورت سرور ایران می‌فرستد |
| `userPort` | فقط روی سرور ایران | کاربران به این پورت وصل می‌شوند |

**`originPort` را از روی تنظیمات CDN بردارید، نه از روی حدس.** پنل CDN پورت origin را خودش انتخاب می‌کند و اگر عدد دیگری در قالب بگذارید، CDN به پورتی می‌رود که کسی آنجا گوش نمی‌دهد و نتیجه فقط `502 Bad Gateway` است.

### آنچه روی آروان‌کلاود اندازه‌گیری شد

با یک شنونده‌ی موقت روی سرور ایران و درخواست از طریق دامنه:

| رفتار | نتیجه |
| --- | --- |
| CDN به کدام پورت origin وصل می‌شود | `HTTPS` روی پورت **۴۴۳** — همان چیزی که در پنل آروان به‌عنوان origin ثبت شده |
| گواهی origin را بررسی می‌کند؟ | **نه.** گواهی خودامضا برای همان دامنه قبول شد، پس `certMode: self-signed` کافی است و به Let's Encrypt یا DNS نیازی نیست |
| ALPN به سمت origin | هیچ ALPNی پیشنهاد نمی‌دهد. بی‌خطر است: `TlsServer` طبق مستندات ALPN را «راهنما» می‌گیرد نه دروازه، و نبودنش handshake را رد نمی‌کند |
| هدر Host | همان دامنه‌ی CDN را می‌فرستد، پس `expectedHost` بی‌خطر است |
| عبور WebSocket | بله — `101 Switching Protocols` و داده دوطرفه بایت‌به‌بایت برگشت (`X-Cache: BYPASS`) |
| IPهای خروجی | متغیر است. در یک نشست `94.101.182.14`، `94.101.183.3` و `185.215.232.195` دیده شد، پس whitelist را از بازه‌های رسمی CDN بردارید نه از چند IP دیده‌شده |

### تنظیمات مهم

- **`originTls`** — به `origin protocol` در پنل CDN نگاه کنید. اگر روی HTTPS باشد (رفتار اندازه‌گیری‌شده‌ی بالا) روشنش کنید؛ اگر CDN خودش TLS را در لبه خاتمه می‌دهد و متن ساده به origin می‌فرستد، خاموش بماند تا `TlsServer` روی ایران حذف شود. روشن بودنش وقتی CDN متن ساده می‌فرستد، دست‌دادن را می‌شکند.
- **`httpVersion`** — پیش‌فرض `1.1`. وب‌سوکت روی HTTP/1.1 با `GET` و `101 Switching Protocols` کار می‌کند؛ حالت ۲ به extended CONNECT نیاز دارد که بیشتر CDNها (از جمله کلاودفلر) برای websocket پشتیبانی نمی‌کنند. ALPN از همین فیلد ساخته می‌شود تا هیچ‌وقت با نسخه HTTP نخواند.
- **`useMux`** — پیش‌فرض روشن. `MuxClient` قبل از `HttpClient` و `MuxServer` بعد از `HttpServer` می‌نشیند، یعنی چند صد اتصال کاربر روی چند WebSocket جمع می‌شود. برای CDN مهم است: تعداد اتصال هم‌زمان و نرخ handshake را کم می‌کند.
- **`whitelist`** — IPهای خروجی CDN. خالی گذاشتن یعنی هر کسی که IP و پورت سرور ایران را پیدا کند می‌تواند به origin وصل شود.
- **`expectedHost`** — فقط روی `HttpServer`. اگر پر شود، درخواست‌های با Host دیگر رد می‌شوند؛ یک لایه محافظت در برابر پروب مستقیم روی IP سرور ایران. روی Hostی که سرور خارج می‌فرستد اثری ندارد، چون آن باید همان دامنه CDN بماند.

### چه چیزهایی را می‌شود ترکیب کرد

**برای مقاومت:**

- **هدرها و مسیر واقع‌نما** — `useMux` + مسیری مثل `/api/v1/stream` و User-Agent مرورگر (پیش‌فرض همین است) تا دست‌دادن از یک XHR معمولی قابل تفکیک نباشد.
- **`websocket-origin` / `websocket-subprotocol`** — اگر پر شوند روی سرور **الزامی** می‌شوند؛ یعنی یک رمز مشترک سبک داخل خود دست‌دادن. هر دو طرف از یک فیلد ساخته می‌شوند تا نخواندن پیش نیاید.
- **`ObfuscatorClient` / `ObfuscatorServer`** روی payload داخل تونل، تا حتی اگر CDN محتوا را باز کند شکل پروتکل دیده نشود.
- **`expectedHost` + whitelist با هم** — جلوی اسکن origin را می‌گیرد، هم با Host اشتباه و هم از IP اشتباه.
- **چند دامنه روی همان CDN** و جابه‌جایی بین آن‌ها، به‌جای یک دامنه ثابت.
- **Reality روی لینک دوم** — اگر بعداً سرور ایران با یک مسیر دیگر (مثلاً یک پروکسی داخلی) به خارج وصل شد، می‌توان لینک را از CDN بیرون آورد و روی `reverse-reality` گذاشت که هیچ گواهی نمی‌خواهد.

**برای سرعت:**

- **`useMux`** — بزرگ‌ترین برد. هر اتصال تازه یک handshake کامل TLS + HTTP و یک رکورد در لاگ CDN است.
- **`nodelay`** روی همه نودهای شبکه (در این قالب پیش‌فرض روشن است).
- **`large-send-buffer` / `large-recv-buffer`** روی شنونده‌های سرور ایران.
- **`edgeAddress`** — قفل کردن روی یک لبه نزدیک و پرسرعت، به‌جای اینکه DNS هر بار لبه متفاوتی بدهد.
- **پروفایل حافظه** — روی سرور ایران `server` و روی خارج `client`. برای سرورهای ۱ گیگابایتی `minimal` بهتر است.
- **حالت `http1-mode: split`** — اگر CDN درخواست طولانی دوطرفه را بافر کرد و websocket جواب نداد، این حالت آپلود و دانلود را به دو درخواست جدا می‌شکند. با `websocket` جمع نمی‌شود و باید هر دو طرف هم‌زمان عوض شوند، پس فعلاً در قالب نیست و دستی ست می‌شود.

### تست

دو مرحله تست شده است.

**۱) دو نمونه واتروال روی یک ماشین** — سرور «ایران» روی `127.0.0.1:18443` گوش می‌دهد، سرور «خارج» با `edgeAddress: 127.0.0.1` و `cdnHost: localhost` به آن وصل می‌شود، و یک `http.server` روی `127.0.0.1:18081` مقصد است. نتیجه: TLS 1.3 با `alpn="http/1.1"`، بالا آمدن هر دو شنونده، و عبور درخواست HTTP از پورت کاربران تا سرویس مقصد.

**۲) دو سرور واقعی پشت آروان‌کلاود** — سرور ایران `193.151.148.56` (Debian 13، ۱ هسته) به‌عنوان origin روی پورت ۴۴۳، سرور آمریکا `192.227.211.124` به‌عنوان خارج، دامنه `mg.ibpublication.ir` با `edgeAddress: 185.143.234.122`، مقصد یک inbound واقعی روی `127.0.0.1:8486`.

نتیجه:

- لینک معکوس بالا آمد: `ReverseClient: connected, wid: 0 unused: 12 active: 0` — یعنی ۱۲ اتصال نگه‌داشته‌شده روی هر ورکر، از داخل CDN.
- `TlsServer: line closed while forwarding decrypted application bytes upstream` هر ۳۰ ثانیه در لاگ origin — این خطا نیست، چرخش طبیعی `MuxClient` با `connection-duration-ms: 30000` است.
- **تست ترافیک واقعی:** یک handshake کامل TLS روی `193.151.148.56:2087` (پورت کاربران) با گواهی `CN=us.hixyz.ir` و `Verify return code: 0 (ok)` برگشت — یعنی بایت‌ها از ایران رفتند، از CDN گذشتند، به آمریکا رسیدند و از `127.0.0.1:8486` جواب گرفتند. هم از خود سرور ایران و هم از یک سرور بیرونی مستقل تأیید شد.
- گواهی origin با `certMode: self-signed` برای `mg.ibpublication.ir` ساخته شد و آروان آن را پذیرفت، بدون هیچ تغییری در DNS یا پنل CDN.

پس اگر مسیر کار نکرد، اول `origin protocol` و پورت origin را در پنل CDN با `originPort` تطبیق دهید، بعد `expectedHost` را با چیزی که CDN به‌عنوان `Host` می‌فرستد.

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
| `stream-fragmenter` | **تکه‌تکه کردن ClientHello** — بدون نیاز به raw socket ⭐️ |
| `first-sni` | **ClientHello جعلی** قبل از واقعی + TTL یا sequence تصادفی |
| `sni-blender` | درهم‌آمیختن ClientHello + پنهان‌کردن پورت |
| `ping-tunnel` | تونل ICMP (**Ping نسخه ۲**) |

### پایداری

| قالب | توضیح |
| --- | --- |
| `half-duplex` | **جدا کردن آپلود و دانلود** در دو اتصال TCP ⭐️ |
| `connection-fisher` | رقابت چند اتصال و نگه‌داشتن اولین مسیری که پاسخ داد |
| `tcp-over-udp` | TCP روی KCP با **FEC** برای مسیرهای پرتلفی |

### لایه ۳ و جریان

| قالب | توضیح |
| --- | --- |
| `tun2socks` | `TunDevice → PacketsToConnection → Socks5Client` — tun2socks داخلی |
| `header-proxy` | **پروتکل PROXY** برای اینکه nginx واقعی IP کاربر را در لاگ ببیند |
| `disturber-lab` | آزمایشگاه: تلفی، تأخیر و خرابی مصنوعی (عملیاتی نیست) |

> قالب‌های علامت‌خورده ⭐️ به **WaterWall 1.46.96** نیاز دارند؛ پنل در انتخابگر نشان می‌دهد و قبل از استقرار هشدار می‌دهد.

## نسخه واتروال

پنل کانفیگ‌ها را برای **1.46.96** می‌سازد و `lib/versions.js` می‌داند در هر نسخه چه چیزی عوض شده.

این مهم است چون واتروال تنظیمات را **حذف** می‌کند و نه منسوخ: یک کلید قدیمی **خطای اجرا** است، نه هشدار. پس پنل هر کانفیگ تولیدشده را قبل از استقرار بررسی می‌کند:

| تنظیم حذف‌شده | نود | از نسخه |
| --- | --- | --- |
| `max-frame-size` | `RealityServer` / `RealityClient` | 1.46.96 |
| `protoswap-tcp-2` | `IpManipulator` | 1.46.96 |
| همه تنظیمات نسخه ۱ | `PingClient` / `PingServer` | 1.46.96 |
| `mode` | `UdpOverTcpClient` | 1.46.96 |

> `max-frame-size` برای `EncryptionClient`/`EncryptionServer` همچنان **معتبر** است — فقط Reality آن را رد می‌کند.

ایجنت نسخه نصب‌شده را گزارش می‌کند و پنل در جدول سرورها نشانش می‌دهد، پس قبل از استقرار می‌فهمید که سرور کدام نسخه را دارد.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/versions
```

### چه چیزی در 1.46.96 اضافه شد

- **splice در کل زنجیره** — داده در صف‌های کرنل می‌ماند و رونویسی نمی‌شود
- **Mux آگاه به splice** — بدون از دست دادن قاب‌بندی MUX
- **TUN GSO/TSO** — `TUN_F_CSUM`، `TUN_F_TSO4` و TCPv4 GSO
- **چک‌سام AVX2** برای CPUهای x86-64
- **`PacketsToConnection`** عملی شد → `tun2socks`
- **`StreamFragmenter`** جدید → تکه‌تکه کردن ClientHello
- **`HttpProxyClient`** جدید با DNS مبدأ
- **Reality نسخه ۲** → `aes-gcm` در کنار `chacha20-poly1305`
- **MTU به‌ازای هر نود** و گزینه `tcp-tune`

## نیمه‌دوطرفه: جدا کردن آپلود و دانلود

بیشتر فیلترینگ **نامتقارن** است: مسیر رفت باز می‌ماند ولی برگشت کند یا محدود می‌شود. `HalfDuplexClient` هر اتصال کاربر را به دو خط TCP جدا تبدیل می‌کند تا کندی برگشت، سرعت ارسال را هم خراب نکند.

```
ایران    کاربر → TcpListener → HalfDuplexClient → TlsClient → TcpConnector
خارج    TcpListener → HalfDuplexServer → TlsServer → TcpConnector
```

دو نیمه با یک مقدمه ۱۷ بایتی جفت می‌شوند که شامل یک شناسه تصادفی ۱۲۸ بیتی است. `HalfDuplexServer` هرکدام را زودتر برسد بافر می‌کند، وقتی هر دو رسیدند یک خط معمولی می‌سازد و مقدمه ۱۷ بایتی را حذف می‌کند. از آن به بعد ادامه زنجیره اصلاً نمی‌داند انتقال دو خطی بوده.

> **شناسه جفت‌شدگی رمزنگاری نیست.** فقط فراداده مسیریابی است. بدون لایه TLS یا Encryption، هرکسی که به پورت لینک برسد می‌تواند در نیمه دانلود تزریق کند. پنل به همین دلیل هشدار می‌دهد و پورت لینک را باید فقط برای IP سرور خارج باز کنید.

## تکه‌تکه کردن ClientHello

`StreamFragmenter` نخستین ClientHello واقعی را به **رکوردهای معتبر** دست‌دادن بازتقسیم می‌کند و بین تکه‌ها تأخیر می‌گذارد. سامانه‌ای که برای تشخیص ترافیک باید ClientHello کامل را ببیند، ناچار است بیشتر بافر کند.

```
ایران    کاربر → TcpListener → StreamFragmenter → TlsClient → TcpConnector
```

نکته مهم: **هیچ داده ساختگی ساخته نمی‌شود.** محتوای بایت‌های handshake دست‌نخورده می‌ماند؛ فقط مرزهای رکورد و زمان‌بندی تغییر می‌کند. این برخلاف ترفندهای قدیمی «ClientHello جعلی» (`first-sni`) است که یک کپی ساختگی وارد می‌کنند و باید راهی برای حذف آن از سرور مقصد پیدا کنند.

هر نقطه برش سه‌تایی است: `آفست، تأخیر (ms)، شانس (%)`:

```
250,2,50
300,5,40
```

مثال بالا یعنی: از بایت ۲۵۰ به بعد را با ۲ میلی‌ثانیه تأخیر و ۵۰٪ شانس بفرست، و از بایت ۳۰۰ به بعد را با ۵ میلی‌ثانیه و ۴۰٪.

> واتروال آفست‌های تکراری را نمی‌پذیرد و آفست‌ها باید اکیداً صعودی باشند. پنل این را قبل از تولید بررسی می‌کند و اگر آفست تکراری باشد **رد** می‌کند، نه اینکه بی‌صدا یکی را نگه دارد.

## tun2socks داخلی

از نسخه ۱.46.96 مسیر پکت ← اتصال عملی شده، یعنی می‌توان ترافیک دلخواه سیستم‌عامل را بدون WireGuard تونل کرد:

```
ایران    TunDevice → PacketsToConnection → Socks5Client → TlsClient → TcpConnector
خارج    TcpListener → TlsServer → Socks5Server → TcpConnector
```

هر جریان TCP/UDP که سیستم‌عامل وارد TUN می‌کند با lwIP بازسازی و به‌صورت خط معمولی واتروال بیرون می‌رود.

> ⚠️ **بدون قانون مسیریابی، تونل بی‌اثر است.** اگر کل ترافیک سیستم را به TUN بفرستید در حالی که بسته‌های خود تونل هم از همان TUN عبور کنند، حلقه مسیریابی می‌سازید و اتصال قطع می‌شود. مسیر ترافیک خود تونل را از TUN مستثنا کنید.

## تونل ICMP با Ping نسخه ۲

ترافیک داخل بسته‌های ICMP Echo جاسازی می‌شود، پس شبکه‌ای که پورت را می‌بندد ولی ICMP را باز گذاشته باشد همچنان تونل را عبور می‌دهد.

**Ping نسخه ۱ و ۲ روی سیم سازگار نیستند.** تنظیمات نسخه ۲ یک مجموعه بسته است و هر کلید دیگری — از جمله تمام کلیدهای استراتژی نسخه ۱ — با خطای مهاجرت رد می‌شود:

```json
{
  "local-ipv4": "203.0.113.10",
  "peer-ipv4": "198.51.100.20",
  "send-replies": false,
  "identifier": 0,
  "sequence-start": 1,
  "ttl": 64,
  "tos": 0
}
```

آدرس‌ها بین دو سمت معکوس می‌شود: هر نود `local-ipv4` خودش و `peer-ipv4` طرف مقابل را دارد. پنل کانفیگ را قبل از تولید بررسی می‌کند تا کانفیگ نسخه ۱ وارد نشود.

## TCP روی UDP با FEC

`TcpOverUdpClient/Server` ترافیک TCP را داخل دیتاگرام KCP می‌برد. KCP به‌جای الگوریتم‌های دوباره‌فرستی TCP تهاجمی‌تر بازارسالی می‌کند، و در صورت فعال بودن FEC قطعات Reed-Solomon می‌توانند یک بریدگی تلفی را **بدون انتظار برای بازارسالی** ترمیم کنند.

با `۱۰` قطعه داده و `۳` قطعه parity، حدود **۳۰٪ بایت بیشتر** روی سیم می‌رود و در عوض تا **۳ بسته گم‌شده در هر بلوک** بدون round-trip ترمیم می‌شود.

FEC را فقط وقتی روشن کنید که مسیر واقعاً تلفی دارد؛ روی مسیر سالم فقط پهنای باند را هدر می‌دهد.

## مقایسه: کدام تکنیک استتار؟

| تکنیک | به raw socket نیاز دارد؟ | داده ساختگی می‌سازد؟ | ریشه |
| --- | --- | --- | --- |
| `stream-fragmenter` | ❌ نه | ❌ نه | بازسازی ClientHello |
| `first-sni` | ✅ بله | ✅ یک کپی جعلی | «اولین» ClientHello |
| `sni-blender` | ✅ بله | ❌ نه | بازسازی ترتیب |
| `ping-tunnel` | ✅ بله | ❌ نه | پروتکل ICMP |
| `protoswap` | ✅ بله | ❌ نه | شماره پروتکل |

اگر نمی‌خواهید به `root` وابسته باشید، `stream-fragmenter` تنها گزینه بدون raw socket است — و در عمل هم تمیزترین است، چون هیچ داده ساختگی وارد جریان نمی‌کند.

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
GET  /api/versions                              نسخه هدف، تغییرات و وضعیت سرورها
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

> ⚠️ نام باینری در آرشیو انتشار رسمی **`Waterwall`** است (حرف w کوچک). روی لینوکس مسیر به حروف حساس است. پنل هر دو نام را می‌پذیرد، ولی اگر دستی نصب می‌کنید بهتر است همان `Waterwall` را نگه دارید.

```ini
[Unit]
Description=WaterWall
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/waterwall
ExecStart=/opt/waterwall/Waterwall
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
    versions.js        دانش نسخه واتروال و تنظیمات حذف‌شده
    stream-adv.js      نیمه‌دوطرفه، تکه‌تکه‌ساز، رقابت مسیر
    l3-new.js          tun2socks، تونل Ping
    stealth.js         ترفندهای SNI، آزمایشگاه لینک
    transport.js       TCP روی UDP، پروتکل PROXY
    ops.js             عملیات
agent/agent.js         ایجنت سمت سرور
public/                رابط کاربری
docs/INSTALL-MANUAL.md راهنمای نصب دستی و آفلاین
install.sh             نصب‌کننده (خودکار و آفلاین)
test/run-tests.js      تست‌ها
test/fake-socks.js     SOCKS5 قلابی برای تست ابزارها
test/install-checks.sh تست‌های اسکریپت نصب
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

## امنیت

پنل می‌تواند روی سرورهای ثبت‌شده **فرمان دلخواه اجرا کند** — این قابلیتی است که یک پنل مدیریتی لازم دارد، و همه تصمیم‌های امنیتی زیر برای همین ساخته شده‌اند.

### مدل تهدید

| دارایی | اگر لو برود |
| --- | --- |
| توکن API | دسترسی کامل به پنل + اجرای فرمان روی هر سرور |
| رمز SSH | دسترسی مستقیم روت به سرور مربوطه |
| کانفیگ تولیدشده | شناسایی پروتکل و پورت‌های تونل |

### کارهایی که پنل انجام می‌دهد

| تصمیم | چرا |
| --- | --- |
| **پیش‌فرض `127.0.0.1`** | با `WW_PANEL_HOST=0.0.0.0` امکان‌پذیر است، ولی هرگز پیش‌فرض نیست؛ گوش دادن روی همه interfaceها یعنی هرکسی که به پورت برسد فرمان روت اجرا می‌کند. اگر bind غیر loopback باشد، هنگام راه‌اندازی هشدار چاپ می‌شود. |
| **توکن فقط با header** | `?token=` فقط روی `/api/events` پذیرفته می‌شود، چون `EventSource` نمی‌تواند header بفرستد. قبول کردن آن روی بقیه مسیرها یعنی توکن در access log، تاریخچه مرورگر و header « Referer» ثبت می‌شود. |
| **مقایسه توکن با `timingSafeEqual`** | جلوگیری از حمله زمانی روی حدس توکن. |
| **`Referrer-Policy: no-referrer`** | رویدادها با توکن در query string احراز هویت می‌شوند؛ بدون این هدر، «Referer» آن را به سایت دیگری می‌برد. |
| **CSP فقط از همین origin** | بدون اسکریپت inline و بدون منبع خارجی، تزریق اسکریپت عملاً بی‌اثر می‌شود. `style-src` به‌خاطر attribute های `style` که هنگام رندر ساخته می‌شوند `'unsafe-inline'` دارد؛ `script-src` ندارد. |
| **`X-Content-Type-Options: nosniff`** | جلوگیری از حدس MIME و اجرای پاسخ JSON به‌عنوان اسکریپت. |
| **`frame-ancestors 'none'` + `X-Frame-Options: DENY`** | جلوگیری از clickjacking. |
| **هر فرمان SSH ثبت می‌شود** | مسیر `POST /api/servers/:id/ssh` عمداً محدود نیست؛ در عوض فرمان دقیق در لاگ می‌رود تا بعداً قابل تشخیص باشد. |
| **مسیر فایل‌های ایستا محصور است** | بررسی containment پسوند جداکننده مسیر را اضافه می‌کند. بدون آن، `..%2f` و پوشه‌های خواهری که نامشان با ریشه یکی شروع می‌شود (مثل `public-x`) قابل خواندن بودند. |
| **ورودی خراب 400 است نه 500** | JSON نامعتبر و درصد-گریز خراب از سمت کلاینت می‌آید؛ گزارش 500 تقصیر سرور را نشان می‌دهد در حالی که تقصیر درخواست است. |
| **`esc()` گیومه تکی را هم escape می‌کند** | خروجی داخل attribute با گیومه تکی (مثل `data-when='…'`) می‌نشست ولی escape نمی‌شد — دقیقاً شکلی که یک attribute-breakout نیاز دارد. |
| **پوشه داده با مجوز `0700`** | توکن و رمزها به متن ساده ذخیره می‌شوند، چون برای استفاده باید خوانا باشند. محافظت، مجوز فایل است نه رمزنگاری. |

### ریسک‌های باقی‌مانده — آگاهانه

- **رمز SSH به متن ساده ذخیره می‌شود** در `data/servers.json`. رمزنگاری بدون ذخیره کلید جایی دیگر فقط جابه‌جایی مشکل است. **کلید SSH استفاده کنید** تا رمزی اصلاً ذخیره نشود؛ در غیر این صورت دسترسی پوشه داده را محدود نگه دارید.
- **بدون rate limiting.** توکن ۱۹۲ بیتی قابل حدس زدن نیست، پس این عملاً مشکلی ایجاد نمی‌کند؛ ولی اگر پنل را در دسترس شبکه گذاشتید، یک لایه محافظت بیشتر لازم است.
- **محدودیت بدنه درخواست ۴ مگابایت است** برای جلوگیری از مصرف حافظه.
- **بدون CSRF token.** احراز هویت با header انجام می‌شود و header را مرورگر به‌صورت خودکار برای درخواست‌های cross-origin نمی‌فرستد، و CSP هم `form-action 'self'` دارد. اگر پنل را به عموم باز کردید، این فرض را دوباره بررسی کنید.


- **Reality واتروال با رمز مشترک کار می‌کند، نه جفت‌کلید.** فیلد `password` بین `RealityClient` و `RealityServer` باید یکسان باشد و حداکثر ۳۲ بایت است — پنل برای همین رمز ۱۶ بایتی hex تولید می‌کند.
- **`TlsServer` به گواهی نیاز دارد.** فیلد «دامنه» را در فرم پر کنید تا پنل هنگام اعمال خودکار گواهی را صادر یا تمدید کند (بخش «گواهی TLS خودکار»). Reality و XOR به گواهی نیاز ندارند.
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
