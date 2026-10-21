# زنجیرهٔ سه‌سروری در پنل واتروال

این راهنما نشان می‌دهد چطور همان زنجیرهٔ **کاربر → آلمان → ایران → ترکیه** را با پنل
`waterwall-panel` بسازید. اگر فقط کانفیگ‌های دستی را می‌خواهید، فایل
`README-fa.md` در ریشهٔ پروژهٔ WaterWall را ببینید؛ این سند مخصوص پنل است.

> این سند سناریوی **Entry (خارج) → Middle (ایران) → Exit (خارج)** است. اگر
> ورودی خود ایران است و می‌خواهید سرور خروجی هیچ پورت ورودی باز نکند، از قالب
> سه‌سمتهٔ `relay-reality` استفاده کنید (بخش «ایران → رله → خارج» در README).
>
> پنل برای این سند ذاتاً **دوطرفه** است: یک سمت `iran` (ورودی) و یک سمت `foreign` (خروجی).
> برای سه سرور، دو تونل می‌سازیم:
>
> 1. تونل اصلی `socks5-reality-mux` بین **آلمان** و **ترکیه**
> 2. تونل تک‌سمتهٔ `tcp-relay` روی **ایران** به‌عنوان هاپ میانی

---

## ۱) نقشهٔ نقش‌ها

| سرور واقعی | نقش در پنل | قالبی که روی آن اعمال می‌شود | پورت عمومی |
|---|---|---|---|
| آلمان (Entry) | `iran` | `socks5-reality-mux` — سمت ورودی | `443` برای Xray؛ `1080` فقط loopback برای WaterWall |
| ایران (Middle) | `iran` | `tcp-relay` — تنها سمت | `443` |
| ترکیه (Exit) | `foreign` | `socks5-reality-mux` — سمت خروجی | `443` |

پنل برای هر تونل فقط یک سمت `iran` و یک سمت `foreign` می‌شناسد. بنابراین:

- تونل اصلی: سمت `iran` = **آلمان**، سمت `foreign` = **ترکیه**
- تونل رله: سمت `iran` = **ایران**؛ این قالب اصلاً سمت `foreign` تولید نمی‌کند

در لیست سرورهای پنل، آلمان و ایران هر دو نقش `iran` دارند. این اشکالی ندارد؛ هنگام
ساخت هر تونل، سرور درست را از dropdown انتخاب کنید.

---

## ۲) پیش‌نیازها

- WaterWall **v1.46.96 یا جدیدتر** و ترجیحاً نسخهٔ یکسان روی هر سه سرور.
- Xray جدید روی آلمان.
- همگام‌سازی ساعت (NTP) روی هر سه سرور؛ `RealityClient` با `verify: true` به زمان
  حساس است.
- دامنهٔ پوشش در دسترس از ترکیه و آلمان (پیش‌فرض `www.microsoft.com`).
- دسترسی root برای bind کردن پورت ۴۴۳.
- اگر از agent استفاده می‌کنید، agent روی هر سه سرور نصب و به پنل وصل باشد.
- اگر از SSH استفاده می‌کنید، کلید SSH پنل روی هر سه سرور نصب شده باشد.

---

## ۳) ثبت سرورها

در پنل → **سرورها**، سه سرور اضافه کنید:

| نام | نقش | Host |
|---|---|---|
| `Germany (entry)` | `iran` | IP آلمان |
| `Iran (middle relay)` | `iran` | IP ایران |
| `Turkey (exit)` | `foreign` | IP ترکیه |

> چرا آلمان نقش `iran` دارد؟ چون در قالب `socks5-reality-mux`، سمت `iran` همان
> زنجیرهٔ ورودی است (`TcpListener → MuxClient → RealityClient`). این فقط یک برچسب
> داخلی پنل است و ربطی به موقعیت جغرافیایی ندارد.

---

## ۴) تونل اصلی: آلمان → ترکیه

**تونل‌ها → تونل جدید → `SOCKS5 over Reality + Mux`**

| فیلد (UI) | کلید API | مقدار برای این طراحی |
|---|---|---|
| سرور ایران | `targetServers.iran` | Germany (entry) |
| سرور خارج | `targetServers.foreign` | Turkey (exit) |
| آدرس شنود محلی | `listenAddress` | `127.0.0.1` |
| پورت شنود محلی | `listenPort` | `1080` |
| پورت عمومی خروجی | `publicPort` | `443` |
| هاپ میانی | `relayHost` | IP ایران |
| آی‌پی مبدأ ورودی | `sourceIp` | IP خروجی آلمان (اختیاری ولی توصیه‌شده) |
| لیست سفید خروجی | `publicWhitelist` | `[IP ایران]` |
| اجازه CONNECT | `socksConnect` | `true` |
| رمز Reality | `realityPassword` | یک رمز تصادفی ≤۳۲ بایت |
| Salt | `realitySalt` | یک salt تصادفی ≤۳۲ بایت |
| الگوریتم | `realityAlgorithm` | `chacha20-poly1305` |
| KDF iterations | `realityKdf` | `12000` |
| SNI / سایت پوشش | `realitySni` / `camouflageHost` | `www.microsoft.com` |
| پورت پوشش | `camouflagePort` | `443` |
| Mux | `muxEnabled` | `true` |
| حالت Mux | `muxMode` | `timer` |
| مدت اتصال Mux | `muxConnectionDurationMs` | `300000` |
| حداکثر فرزند | `muxMaxChildren` | `4096` |
| پروفایل حافظه | `_core.ramProfile` | `server` (یا `client` برای VPS کوچک) |

### زنجیرهٔ تولیدشده

**آلمان (سمت `iran`):**

```text
TcpListener 127.0.0.1:1080
  → MuxClient (timer, 300000 ms)
  → RealityClient (SNI=www.microsoft.com, password/salt, verify=true)
  → TcpConnector IRAN_IP:443 (source-ip = GERMANY_IP)
```

**ترکیه (سمت `foreign`):**

```text
TcpListener 0.0.0.0:443 (whitelist = [IRAN_IP])
  → RealityServer
  → MuxServer (max-children=4096)
  → Socks5Server (no-auth=true, connect=true, udp=false)
  → TcpConnector dest_context->address / dest_context->port

RealityServer.destination → TcpConnector www.microsoft.com:443
```

> فیلد «هاپ میانی» باعث می‌شود `TcpConnector` آلمان به IP ایران وصل شود، نه
> مستقیماً به ترکیه. اگر خالی بماند، اتصال مستقیم دو‌سروری می‌شود.
>
> فیلد «لیست سفید خروجی» باعث می‌شود `TcpListener` ترکیه فقط IP ایران را قبول
> کند. اگر خالی بماند، پنل IP هاپ میانی (اگر پر شده باشد) و در غیر این صورت IP
> سرور ورودی (آلمان) را می‌گذارد.

---

## ۵) تونل رله: ایران

**تونل‌ها → تونل جدید → `TCP Relay (middle hop)`**

| فیلد (UI) | کلید API | مقدار |
|---|---|---|
| سرور ایران | `targetServers.iran` | Iran (middle relay) |
| سرور خارج | `targetServers.foreign` | UI این فیلد را برای قالب تک‌سمته نشان نمی‌دهد؛ با API خالی بگذارید |
| آدرس شنود | `listenAddress` | `0.0.0.0` |
| پورت شنود | `listenPort` | `443` |
| لیست سفید ورودی | `whitelist` | `[GERMANY_IP]` |
| آدرس خروجی | `destAddress` | `TURKEY_IP` |
| پورت خروجی | `destPort` | `443` |
| آی‌پی مبدأ خروجی | `sourceIp` | `IRAN_IP` |
| تایم‌اوت اولیه | `initialIdleTimeoutMs` | `30000` |
| تایم‌اوت فعال | `activeIdleTimeoutMs` | `3600000` |
| پروفایل حافظه | `_core.ramProfile` | `client` |

### زنجیرهٔ تولیدشده

```text
TcpListener 0.0.0.0:443 (whitelist = [GERMANY_IP])
  → TcpConnector TURKEY_IP:443 (source-ip = IRAN_IP)
```

این قالب **هیچ** `RealityServer`، `Socks5Server`، `MuxServer` یا گره رمزگشایی
ندارد. فقط بایت‌های TLS لایهٔ آلمان↔ترکیه را رد می‌کند.

> `destAddress` را دستی پر کنید. اگر خالی بماند، پنل از IP سرور خارجی ثبت‌شده
> استفاده می‌کند؛ در حالت سه‌سروری این کار ممکن است به‌جای ترکیه، سرور اشتباهی
> انتخاب کند.
>
> `sourceIp` ایران باید دقیقاً همان IP‌ای باشد که در «لیست سفید خروجی» تونل اصلی
> (ترکیه) گذاشته‌اید. وگرنه ترکیه اتصال را رد می‌کند.

---

## ۶) استقرار به ترتیب درست

ترتیب پیشنهادی: **ترکیه → ایران → آلمان → Xray**

1. **ترکیه:** تونل اصلی را فقط روی سمت `foreign` اعمال کنید.
2. **ایران:** تونل رله را اعمال کنید (پنل به‌صورت خودکار فقط سمت `iran` را می‌فرستد).
3. **آلمان:** تونل اصلی را فقط روی سمت `iran` اعمال کنید.
4. **آلمان:** Xray را با کانفیگ VLESS+Reality بالا بیاورید.

اگر از UI استفاده می‌کنید و دکمهٔ «اعمال» هر دو سمت تونل اصلی را می‌فرستد، می‌توانید:

- اول تونل اصلی را اعمال کنید (آلمان + ترکیه)،
- بعد تونل رله را اعمال کنید،
- و در صورت نیاز سرویس WaterWall آلمان را یک‌بار restart کنید.

نسخهٔ دقیق‌تر با API:

```bash
# 1) فقط ترکیه
curl -sS -X POST "http://PANEL:8787/api/tunnels/OUTER_ID/apply" \
  -H "Authorization: Bearer PANEL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sides":["foreign"],"restart":true}'

# 2) ایران (تونل رله)
curl -sS -X POST "http://PANEL:8787/api/tunnels/RELAY_ID/apply" \
  -H "Authorization: Bearer PANEL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sides":["iran"],"restart":true}'

# 3) فقط آلمان
curl -sS -X POST "http://PANEL:8787/api/tunnels/OUTER_ID/apply" \
  -H "Authorization: Bearer PANEL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sides":["iran"],"restart":true}'
```

> اگر پنل را با agent اجرا می‌کنید، agent هر سرور فقط بستهٔ همان نقش را می‌گیرد.
> تونل رله برای ترکیه بستهٔ `foreign` تولید نمی‌کند، پس agent ترکیه آن را نادیده
> می‌گیرد.

---

## ۷) Xray روی آلمان

پنل Xray را مدیریت نمی‌کند. از `configs/xray/germany-server.json` به‌عنوان پایه
استفاده کنید و این موارد را عوض کنید:

- `inbounds[0].port` = `443`
- `inbounds[0].settings.clients[0].id` = UUID تازه (`xray uuid`)
- `streamSettings.realitySettings.privateKey` = کلید خصوصی تازه (`xray x25519`)
- `shortIds` = shortId تازه
- `serverNames` / `target` = دامنهٔ پوشش (پیش‌فرض `www.microsoft.com:443`)
- `outbounds` → `ww-socks` باید به `127.0.0.1:1080` اشاره کند
- routing: DNS → `dns-out`، بقیهٔ UDP → `block`، بقیهٔ TCP → `ww-socks`

کلاینت فقط به **IP آلمان:443** وصل می‌شود. لینک را از
`configs/xray/vless-link.txt` بسازید و مطمئن شوید:

- `IRAN_IP` در لینک نیست.
- `TURKEY_IP` در لینک نیست.
- `pbk` = کلید عمومی متناظر با `privateKey` سرور است.
- `sid` = یکی از `shortIds` سرور است.

---

## ۸) فایروال

### آلمان

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 443/tcp          # Xray users
# 1080 را باز نکنید؛ فقط loopback است.
ufw enable
```

### ایران

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow from GERMANY_IP to any port 443 proto tcp
ufw enable
```

### ترکیه

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow from IRAN_IP to any port 443 proto tcp
ufw enable
```

> `whitelist` واتروال و فایروال هر دو لازم‌اند. فایروال جلوی اتصال TCP را می‌گیرد؛
> `whitelist` جلوی پذیرش درخواست توسط خود WaterWall را.

---

## ۹) تست‌ها

روی آلمان:

```bash
ss -lntp | grep -E ':(443|1080)'
nc -vz IRAN_IP 443
```

روی ایران:

```bash
ss -lntp | grep ':443'
nc -vz TURKEY_IP 443
```

روی ترکیه:

```bash
ss -lntp | grep ':443'
curl -I https://www.microsoft.com
```

تست سرتاسری از آلمان (بعد از بالا آمدن هر سه):

```bash
curl --socks5-hostname 127.0.0.1:1080 https://ifconfig.me
```

باید IP **ترکیه** را نشان دهد، نه آلمان یا ایران. اگر IP آلمان را نشان داد،
Xray/WaterWall به‌درستی به تونل وصل نشده‌اند. اگر خطا داد، لاگ‌ها را ببینید:

```bash
journalctl -u waterwall -n 100 --no-pager
journalctl -u xray -n 100 --no-pager
```

از سمت کلاینت:

- به `GERMANY_IP:443` با `VLESS + Reality` وصل شوید.
- `https://ifconfig.me` باید IP ترکیه را نشان دهد.
- اگر کلاینت وصل شد ولی سایت باز نشد، احتمالاً `Socks5Server` یا routing Xray
  مشکل دارد؛ `udp: false` است و DNS باید از آلمان پاسخ داده شود.

---

## ۱۰) چک‌لیست امنیتی

- [ ] IP ایران در لینک کلاینت، subscription یا پنل کاربران نیست.
- [ ] IP ترکیه هم در لینک کلاینت نیست (فقط آلمان).
- [ ] `TcpListener` آلمان روی `127.0.0.1` است، نه `0.0.0.0`.
- [ ] `whitelist` ایران = IP آلمان؛ `whitelist` ترکیه = IP ایران.
- [ ] `sourceIp` آلمان = IP آلمان؛ `sourceIp` ایران = IP ایران.
- [ ] رمز/Salt Reality بین آلمان و ترکیه یکی است و قبل از استقرار rotate شده.
- [ ] UUID و کلیدهای Xray قبل از استقرار rotate شده‌اند.
- [ ] نسخهٔ WaterWall روی هر سه سرور یکسان است.
- [ ] ساعت هر سه سرور همگام است.
- [ ] روی ایران هیچ `RealityServer`/`Socks5Server`/`MuxServer` وجود ندارد.
- [ ] پورت ۱۰۸۰ آلمان در فایروال باز نیست.
- [ ] پورت ۴۴۳ ترکیه فقط از IP ایران قابل دسترسی است.
- [ ] `Socks5Server` ترکیه `udp: false` دارد (این زنجیره UDP را حمل نمی‌کند).

---

## ۱۱) عیب‌یابی سریع

| نشانه | احتمال | راه‌حل |
|---|---|---|
| آلمان به ایران وصل نمی‌شود | فایروال ایران / IP اشتباه | `nc -vz IRAN_IP 443` و `ufw status` |
| ایران به ترکیه وصل نمی‌شود | فایروال ترکیه / `sourceIp` اشتباه | `nc -vz TURKEY_IP 443`؛ `sourceIp` ایران را با whitelist ترکیه هماهنگ کنید |
| `Reality` handshake شکست می‌خورد | رمز/Salt ناهماهنگ، ساعت، SNI | رمز/Salt را چک کنید؛ NTP؛ `www.microsoft.com` را از ترکیه تست کنید |
| کلاینت وصل می‌شود ولی اینترنت ندارد | routing Xray / `Socks5Server` | `curl --socks5-hostname` از آلمان؛ لاگ WaterWall ترکیه |
| پورت ۴۴۳ آلمان در استفاده است | Xray و WaterWall هر دو روی ۴۴۳ | WaterWall آلمان باید `127.0.0.1:1080` باشد؛ Xray روی `0.0.0.0:443` |
| پنل هنگام apply تونل رله خطای سمت خارج می‌دهد | نسخهٔ قدیمی پنل | پنل باید `sides` را از باندل‌های موجود بگیرد؛ به‌روزرسانی پنل یا ارسال `{"sides":["iran"]}` |
| agent ترکیه کانفیگ رله را می‌گیرد | باگ قدیمی | تونل رله نباید بستهٔ `foreign` داشته باشد؛ پنل جدید این را رعایت می‌کند |

---

## ۱۲) تولید باندل‌های نمونه با اسکریپت

برای دیدن خروجی دقیق پنل بدون deploying:

```bash
node scripts/panel-preview-3hop.js
```

این اسکریپت با IPهای نمونه و رمزهای نمونه، سه پوشه می‌سازد:

```text
configs/panel-generated/
  germany/core.json
  germany/configs/socks5-reality.json
  iran/core.json
  iran/configs/tcp-relay.json
  turkey/core.json
  turkey/configs/socks5-reality.json
```

> این‌ها فقط نمونه‌اند. قبل از استقرار، IPها و رمزها را عوض کنید. اسکریپت
> `scripts/check-configs.ps1` این پوشه را هم بررسی می‌کند.

---

## ۱۳) تفاوت با کانفیگ‌های دستی

پوشهٔ `configs/germany|iran|turkey` نسخهٔ دستی و «tuned» است و فیلدهای اضافی
مثل `keepalive`، `tolerance-ms`، `tls12-gcm-server-nonce-policy` و
`x25519mlkem768` دارد. پوشهٔ `configs/panel-generated` خروجی دقیق پنل است و
فقط فیلدهایی را دارد که پنل تولید و اعتبارسنجی می‌کند.

- اگر می‌خواهید پنل مدیریت کند: از `configs/panel-generated` استفاده کنید.
- اگر کانفیگ دستی با تنظیمات بیشتری می‌خواهید: از `configs/germany|iran|turkey`
  استفاده کنید و همان‌ها را روی سرور بگذارید.
- هر دو مسیر از نظر ساختاری با `scripts/check-configs.ps1` بررسی می‌شوند.

> فیلدهای tuned باید روی هر دو سرور همان لایه پشتیبانی شوند؛ مثلاً
> `x25519mlkem768` در `RealityClient` آلمان باید با `RealityServer` ترکیه سازگار
> باشد. اگر نسخهٔ WaterWall روی سرورها یکسان نیست یا مطمئن نیستید، باندل‌های پنل
> را انتخاب کنید.

---

## ۱۴) نکتهٔ UDP

این زنجیره فقط TCP است:

- `Socks5Server` ترکیه `udp: false` دارد.
- `Mux` یک تونل stream است و UDP را حمل نمی‌کند.
- Xray در آلمان بقیهٔ UDP را block می‌کند تا کلاینت سریع به TCP fallback کند.

اگر به UDP واقعی (بازی، تماس صوتی، QUIC) نیاز دارید، باید زنجیره را با
`TcpUdpListener`/`UdpConnector` و یک لایهٔ UDP جداگانه گسترش دهید؛ این طراحی
عمداً ساده و مقاوم نگه داشته شده است.

---

## ۱۵) امنیت و عملکرد

### لایه‌های رمزنگاری

| بخش | رمزنگاری | چه کسی رمزگشایی می‌کند |
|---|---|---|
| کاربر → آلمان | Xray VLESS + Reality + TLS 1.3 + `xtls-rprx-vision` | آلمان (Xray) |
| آلمان → ترکیه | WaterWall Reality v2 + AEAD (`chacha20-poly1305` یا `aes-256-gcm`) + استتار TLS 1.3 | ترکیه (RealityServer) |
| ایران | فقط L4 TCP relay | هیچ‌کس؛ محتوا را نمی‌بیند |

- `RealityClient`/`RealityServer` یک handshake واقعی TLS 1.3 با سایت پوشش انجام می‌دهند؛ probe بدون رمز به سایت پوشش می‌رسد.
- `x25519mlkem768` در `RealityClient` پیش‌فرض `true` است؛ حتی اگر در کانفیگ پنل نوشته نشده باشد فعال است.
- `MuxClient` به‌صورت پیش‌فرض `keepalive=true`، `ping-interval=15000` و `tolerance-ms=45000` دارد؛ کانفیگ دستی این‌ها را صریح نوشته و کانفیگ پنل به default تکیه می‌کند.
- IP ایران در لینک کاربر نیست؛ لینک فقط `GERMANY_IP:443` را دارد.

### امنیت سرور (حداقل)

1. SSH فقط با کلید: `PasswordAuthentication no` و `PermitRootLogin prohibit-password` یا `no`.
2. فایروال:
   - آلمان: `443/tcp` از همه، `22/tcp` از IP مدیریت، `1080`/`8787` فقط loopback.
   - ایران: `443/tcp` فقط از IP آلمان، `22/tcp` از IP مدیریت.
   - ترکیه: `443/tcp` فقط از IP ایران، `22/tcp` از IP مدیریت.
3. `fail2ban` + `unattended-upgrades`.
4. پنل روی `127.0.0.1:8787`؛ دسترسی با `ssh -L 8787:127.0.0.1:8787 user@PANEL_HOST`؛ توکن `data/panel.json` با `chmod 600`.
5. سرویس‌ها با کاربر اختصاصی و `NoNewPrivileges`، `PrivateTmp`، `ProtectSystem`، `ProtectHome` و `AmbientCapabilities=CAP_NET_BIND_SERVICE`.
6. اسرار تصادفی: `openssl rand -hex 16` برای password/salt، `xray uuid`، `xray x25519` و `openssl rand -hex 8` برای shortId. رمز Xray و WaterWall را جدا نگه دارید.
7. NTP: `timedatectl set-ntp true` و بررسی `timedatectl`.
8. لاگ را روی `warning` نگه دارید و لاگ verbose را طولانی‌مدت نگه ندارید.

### پینگ

```text
RTT_total ≈ RTT(user→Germany) + RTT(Germany→Iran) + RTT(Iran→Turkey)
```

برای کاربر ایرانی، مسیر آلمان→ایران در hairpin دو بار طی می‌شود؛ این هزینهٔ اصلی است، نه رمزنگاری. با `mtr` هر سه مسیر را اندازه بگیرید. اگر یک مسیر loss/jitter دارد، ارائه‌دهنده/لوکیشن را عوض کنید.

- BBR + `fq`: فایل `configs/sysctl/99-waterwall.conf` در ریشهٔ پروژه.
- `Mux` duration را روی `300000ms` نگه دارید؛ کمتر از ۶۰ ثانیه نکنید.
- `chacha20-poly1305` پیش‌فرض است؛ روی CPU با AES-NI می‌توانید `aes-256-gcm` را تست کنید.
- Mux داخل Xray را روشن نکنید؛ `xtls-rprx-vision` کافی است.
- Reality کل زنجیره را از splice محروم می‌کند (`kNodeFlagBlocksSplice`)؛ این هزینهٔ CPU/throughput است، نه RTT. روی VPS با AES-NI و ۲ worker معمولاً مشکلی نیست.
- UDP فقط برای DNS؛ برای voice/gaming مسیر جدا لازم است.

### تست

```bash
# از آلمان
curl --socks5-hostname 127.0.0.1:1080 https://ifconfig.me
ping -c 20 IRAN_IP
mtr -rwzbc 50 IRAN_IP

# از ایران
ping -c 20 GERMANY_IP
ping -c 20 TURKEY_IP

# اگر ICMP بسته است، برای ping/mtr موقتاً از IP مقابل باز کنید:
# sudo ufw allow from PEER_IP to any proto icmp

# throughput را برای هر hop جدا تست کنید (نه آلمان→ترکیه مستقیم):
# روی ایران، موقتاً 5201 را از IP آلمان باز کنید و iperf3 -s اجرا کنید:
# sudo ufw allow from GERMANY_IP to any port 5201 proto tcp
# iperf3 -s
# سپس از آلمان: iperf3 -c IRAN_IP -t 30
# و بعد rule را حذف کنید: sudo ufw delete allow from GERMANY_IP to any port 5201 proto tcp
# برای ایران→ترکیه همین کار را با IP ایران روی ترکیه تکرار کنید.
```

> جزئیات کامل‌تر (SSH، UFW، fail2ban، systemd، BBR و جدول تنظیمات) در بخش ۱۳ فایل
> `README-fa.md` در ریشهٔ پروژهٔ WaterWall آمده است.
