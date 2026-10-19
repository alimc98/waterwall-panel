# نصب صفر تا صد — پنل + واتروال + تانل

این سند دقیقاً همان مسیری است که برای راه‌اندازی واقعی طی شد: از دو سرور خام تا تانل کارکننده و پنل قابل دسترسی با IP و پورت.

جای‌هایی که «مثال» می‌بینید را با مقادیر خودتان عوض کنید:

| نام | مثال | توضیح |
| --- | --- | --- |
| `IRAN_IP` | `193.151.148.56` | IP عمومی سرور ایران |
| `FOREIGN_IP` | `192.227.211.124` | IP عمومی سرور خارج |
| `PANEL_PORT` | `8787` | پورتی که پنل روی سرور ایران گوش می‌دهد |
| `TOKEN` | ۶۴ کاراکتر هگز | توکن API پنل (اسکریپت خودش می‌سازد) |

> **هشدار امنیتی مهم:** توکن پنل اجازهٔ اجرای دستور روی هر سروری که در پنل ثبت می‌کنید را می‌دهد. هر کسی که IP:PORT پنل را ببیند صفحهٔ ورود را می‌بیند و با توکن، کنترل کامل دارد. توکن را مثل رمز روت نگه دارید. اگر لازم نیست از اینترنت باز باشد، `--host 127.0.0.1` بدهید و با تونل SSH وصل شوید.

---

## مرحلهٔ ۰ — پیش‌نیازها

- دو سرور لینوکس (Debian/Ubuntu کافی است) با دسترسی root و IP عمومی.
- روی سرور ایران باید پورت‌های عمومی مورد استفاده (مثلاً 443 و 2087) آزاد باشند.
- Node.js 18+ روی هر دو سرور؛ اگر نبود، اسکریپت‌های زیر خودشان نصب می‌کنند (روی Debian: `apt-get install -y nodejs`).
- برای تانل‌های TLS/CDN یک دامنه که DNS آن به سرور ایران اشاره می‌کند.

بررسی سریع:

```bash
node -v            # باید 18 یا بالاتر باشد
ss -lntp           # ببینید چه چیزی روی پورت‌ها گوش می‌دهد
```

---

## مرحلهٔ ۱ — نصب پنل روی سرور ایران (خودکار)

فایل‌های پنل را روی سرور ببرید (از ویندوز با `scp` یا `tar` و `ssh`)، بعد:

```bash
tar -xzf waterwall-panel.tar.gz -C /root/panel
cd /root/panel
sudo bash panel-install.sh --source . --port 8787 --host 0.0.0.0
```

خروجی اسکریپت سه چیز می‌دهد: آدرس پنل، توکن، و وضعیت سرویس. نمونه:

```
UI      : http://193.151.148.56:8787
Token   : 9f2c...e41d
Unit    : systemctl status waterwall-panel
```

### همان کار، دستی

اگر ترجیح می‌دهید همه‌چیز را خودتان ببینید:

```bash
apt-get update && apt-get install -y nodejs
mkdir -p /opt/waterwall-panel/data
cp -r server.js package.json public lib agent install.sh panel-install.sh docs /opt/waterwall-panel/
chmod 0700 /opt/waterwall-panel/data

TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
cat > /etc/waterwall-panel.env <<EOF
WW_PANEL_HOST=0.0.0.0
WW_PANEL_HOST=0.0.0.0
WW_PANEL_PORT=8787
WW_PANEL_DATA=/opt/waterwall-panel/data
WW_PANEL_TOKEN=$TOKEN
EOF
chmod 0600 /etc/waterwall-panel.env

cat > /etc/systemd/system/waterwall-panel.service <<'EOF'
[Unit]
Description=WaterWall Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/waterwall-panel
EnvironmentFile=/etc/waterwall-panel.env
ExecStart=/usr/bin/node /opt/waterwall-panel/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now waterwall-panel
journalctl -u waterwall-panel -n 20 --no-pager
```

### نصب کاملاً آفلاین

`panel-install.sh --offline --source /path/to/panel` هیچ تماسی با اینترنت نمی‌گیرد؛ فقط باید Node.js 18+ از قبل نصب شده باشد.

---

## مرحلهٔ ۲ — بازکردن دسترسی خارجی به پنل

۱. مطمئن شوید سرویس روی همهٔ اینترفیس‌ها گوش می‌دهد:

```bash
ss -lntp | grep 8787        # باید 0.0.0.0:8787 یا *:8787 باشد
```

۲. از یک سرور **دیگر** (نه خود ایران) تست کنید:

```bash
curl -s -m 5 -H "Authorization: Bearer $TOKEN" http://IRAN_IP:8787/api/servers
# {"ok":true,"servers":[]}
```

۳. تست بدون توکن باید ۴۰۱ بدهد:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://IRAN_IP:8787/api/servers   # 401
```

۴. اگر باز نشد: فایروال سرور/دیتاسنتر را بررسی کنید (روی ایران در این پروژه فایروال محلی وجود نداشت):

```bash
ufw status || iptables -S | head
```

نکته‌های امنیتی:

- توکن را در URL نگذارید (لاگ‌ها و history). همیشه هدر `Authorization: Bearer ...`.
- برای دسترسی امن‌تر: `--host 127.0.0.1` + تونل SSH:
  `ssh -L 8787:127.0.0.1:8787 root@IRAN_IP` و بعد مرورگر روی `http://127.0.0.1:8787`.
- اگر پنل عمومی است، جلوی آن یک reverse proxy با TLS بگذارید (nginx/caddy) و پورت 8787 را به localhost محدود کنید.
- فایل `/etc/waterwall-panel.env` و پوشهٔ `data/` پنل (شامل رمزهای SSH سرورها) را بک‌آپ و محافظت کنید.

---

## مرحلهٔ ۳ — ثبت دو سرور در پنل

از رابط کاربری: بخش «سرورها» → افزودن سرور → نقش (ایران/خارج)، IP، کاربر و رمز SSH.

یا با API:

```bash
curl -s -X POST http://IRAN_IP:8787/api/servers \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Iran","role":"iran","host":"IRAN_IP","sshUser":"root","sshPassword":"ROOT_PASS"}'

curl -s -X POST http://IRAN_IP:8787/api/servers \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Foreign","role":"foreign","host":"FOREIGN_IP","sshUser":"root","sshPassword":"ROOT_PASS"}'
```

هر پاسخ یک `agentToken` دارد؛ همان را در مرحلهٔ بعد لازم دارید. برای دیدن دوباره:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://IRAN_IP:8787/api/servers
```

---

## مرحلهٔ ۴ — نصب واتروال + ایجنت روی هر دو سرور

روی **هر دو** سرور (ایران و خارج) اجرا کنید. اگر واتروال از قبل نصب است، `--skip-waterwall` اضافه کنید:

```bash
curl -fsSL http://IRAN_IP:8787/install.sh -o /root/install.sh
sudo bash /root/install.sh \
  --panel-url http://IRAN_IP:8787 \
  --agent-token <AGENT_TOKEN آن سرور> \
  --skip-waterwall
```

نصب کامل (واتروال + ایجنت) روی سرور تازه:

```bash
sudo bash /root/install.sh --panel-url http://IRAN_IP:8787 --agent-token <AGENT_TOKEN> --arch x64-old
```

نصب آفلاین (سروری که به GitHub دسترسی ندارد):

```bash
sudo bash /root/install.sh --offline \
  --waterwall-zip /root/Waterwall-linux-gcc-x64-old-cpu.zip \
  --agent-file /root/agent.js \
  --panel-url http://IRAN_IP:8787 --agent-token <AGENT_TOKEN>
```

ایجنت هر ۱۵ ثانیه وضعیت و کانفیگ را از پنل می‌گیرد. تست:

```bash
systemctl status ww-agent --no-pager
journalctl -u ww-agent -n 20 --no-pager
```

و از سمت پنل:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://IRAN_IP:8787/api/servers
# هر سرور باید lastStatus و agentVersion داشته باشد
```

تا وقتی هیچ تانلی «اعمال» نشود، ایجنت هیچ فایلی را تغییر نمی‌دهد و تانل زندهٔ فعلی دست‌نخورده می‌ماند.

---

## مرحلهٔ ۵ — ساخت و اعمال تانل از پنل

۱. «تانل جدید» → قالب را انتخاب کنید:
   - `tcp-forward` برای فوروارد سادهٔ یک پورت.
   - `cdn-reverse-wss` برای عبور از CDN (نیاز به دامنه و گواهی؛ حالت امن تست‌شدهٔ همین پروژه).
   - `socks5-upstream` / `vless-tls` برای پروکسی کاربران.
۲. سرورها را انتخاب کنید (ایران/خارج) و پورت‌ها را پر کنید.
۳. «پیش‌نمایش» را ببینید؛ JSON ساخته‌شده برای هر دو سمت را نشان می‌دهد.
۴. «ذخیره و اعمال» → ایجنت روی هر دو سرور فایل را می‌نویسد، از فایل قبلی `.bak.<timestamp>` می‌گیرد و سرویس واتروال را ری‌استارت می‌کند.

نکتهٔ مهم: **اعمال تانل، `core.json` را بازنویسی می‌کند.** همهٔ تانل‌هایی که در پنل «فعال» هستند با هم اعمال می‌شوند (لیست `configs` در `core.json` ادغام می‌شود)، پس چند تانل روی یک سرور با هم کار می‌کنند. اما تانل زندهٔ دیگری که در پنل ثبت نشده باشد بعد از اعمال از دست می‌رود؛ اول آن را در پنل بسازید.

---

## مرحلهٔ ۶ — تأیید نهایی

از یک سرور بیرونی (نه ایران و نه خارج):

```bash
# پورت سرویس روی ایران جواب می‌دهد؟
timeout 5 bash -c '</dev/tcp/IRAN_IP/2087' && echo open

# گواهی TLS و SNI درست است؟ (تانل‌های TLS)
openssl s_client -connect IRAN_IP:2087 -servername YOUR_DOMAIN -brief </dev/null

# پروکسی SOCKS5 کار می‌کند؟ (IP خروجی باید IP سرور خارج باشد)
curl -s --socks5-hostname USER:PASS@IRAN_IP:1080 https://ifconfig.me/ip
```

روی خود سرور:

```bash
systemctl status waterwall --no-pager
journalctl -u waterwall -n 30 --no-pager | grep -Ei 'fatal|error|warn'
ss -lntup | grep -E 'waterwall|2087|443'
```

---

## مرحلهٔ ۷ — عیب‌یابی

| نشانه | کار | توضیح |
| --- | --- | --- |
| صفحهٔ پنل باز نمی‌شود | `ss -lntp \| grep 8787` | اگر روی `127.0.0.1:8787` گوش می‌دهد، در `/etc/waterwall-panel.env` مقدار `WW_PANEL_HOST=0.0.0.0` را بگذارید و `systemctl restart waterwall-panel` را اجرا کنید |
| `401` روی API | توکن غلط | توکن واقعی: `grep WW_PANEL_TOKEN /etc/waterwall-panel.env` |
| ایجنت وضعیت نمی‌دهد | `journalctl -u ww-agent -f` | آدرس پنل و `--agent-token` باید دقیق باشد |
| واتروال بالا نمی‌آید | `journalctl -u waterwall -n 50` | خطوط `FATAL` دقیقاً می‌گویند کدام کلید تنظیمات مشکل دارد |
| تانل بالاست ولی داده عبور نمی‌کند | لاگ واتروال با `--verbose` | مسیر داده را مرحله‌به‌مرحله نشان می‌دهد |

فایل‌های مهم روی سرورها:

| مسیر | چیست |
| --- | --- |
| `/opt/waterwall/Waterwall` | باینری هسته |
| `/opt/waterwall/core.json` | تنظیمات هسته + لیست کانفیگ‌ها |
| `/opt/waterwall/configs/*.json` | کانفیگ تانل‌ها |
| `/opt/ww-agent/agent.js` | ایجنت |
| `/var/lib/ww-agent/state.json` | آخرین هش اعمال‌شده |
| `/opt/waterwall-panel/data/` | داده پنل: سرورها، تانل‌ها، گواهی‌ها، توکن |

---

## مرحلهٔ ۸ — بک‌آپ، آپدیت و حذف

```bash
# بک‌آپ پنل
tar -czf /root/panel-backup-$(date +%F).tgz /opt/waterwall-panel/data /etc/waterwall-panel.env

# آپدیت پنل (فایل‌ها جایگزین می‌شوند، data دست نمی‌خورد)
bash panel-install.sh --source /root/panel-new --force

# ری‌استارت سرویس‌ها
systemctl restart waterwall-panel ww-agent waterwall

# حذف ایجنت از یک سرور
systemctl disable --now ww-agent && rm -rf /opt/ww-agent /var/lib/ww-agent
```

---

## پیوست — چک‌لیست کوتاه

```text
[ ] Node.js 18+ روی هر دو سرور
[ ] panel-install.sh روی سرور ایران → آدرس + توکن
[ ] ss -lntp | grep 8787  →  0.0.0.0:8787
[ ] curl از سرور بیرونی با توکن → 200 ; بدون توکن → 401
[ ] دو سرور در پنل ثبت شدند (نقش ایران/خارج)
[ ] install.sh روی هر دو سرور با agent-token همان سرور
[ ] systemctl status ww-agent → active (running)
[ ] پنل وضعیت هر دو ایجنت را نشان می‌دهد
[ ] تانل ساخته و اعمال شد
[ ] تست بیرونی: پورت باز + گواهی/TLS درست + IP خروجی سرور خارج
```
