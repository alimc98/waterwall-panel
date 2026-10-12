# نصب دستی و آفلاین

راهنمای کامل نصب **بدون هیچ اسکریپتی**. هر دستور را خودتان تایپ می‌کنید و هیچ چیزی از اینترنت گرفته نمی‌شود.

## چرا این سند وجود دارد

| موقعیت | راه‌حل |
| --- | --- |
| سرور ایران به گیت‌هاب دسترسی ندارد | فایل zip را روی کامپیوتر خودتان بگیرید و با SCP منتقل کنید |
| ارتباط ایران↔خارج قطع است و هر دو سرور آفلاین‌اند | یک‌بار روی یک سرور نصب کنید، پوشه را کپی و به سرور دوم بفرستید |
| `curl` یا `unzip` نصب نیست | بخش «بدون ابزار کمکی» |
| سیاست سازمان اجازه اسکریپت نمی‌دهد | همین سند، مرحله‌به‌مرحله |
| می‌خواهید بدانید دقیقاً چه چیزی نصب می‌شود | همین سند |

> اگر دسترسی به گیت‌هاب دارید، `install.sh` کار را در یک مرحله انجام می‌دهد. این سند جایگزین آن است، نه مکملش.

---

## پیش‌نیازها

### روی سرور

```bash
cat /etc/os-release | head -3      # باید لینوکس باشد
uname -m                          # x86_64 یا aarch64
free -m                           # حداقل 512MB
```

| مورد | کمینه | پیشنهادی |
| --- | --- | --- |
| سیستم‌عامل | لینوکس با systemd | Ubuntu 22.04 / Debian 12 |
| RAM | 512 MB | 1 GB به بالا |
| هسته | ۲۴ | نود کانفیگ به‌ازای هر هسته |
| پورت‌ها | ۱ پورت کاربر + ۱ پورت لینک | بیشتر برای چند تونل |

### ابزار

```bash
command -v unzip || echo "unzip نیست"
command -v systemctl || echo "systemd نیست"
command -v node || echo "node نیست (فقط برای ایجنت لازم است)"
```

`systemctl` و `curl`/`wget` ضروری‌اند. اگر `unzip` ندارید بخش [بدون unzip](#بدون-unzip) را ببینید.

---

## مرحله ۱: آماده کردن فایل‌ها روی کامپیوتر خودتان

این بخش روی **کامپیوتر خودتان** انجام می‌شود، نه روی سرور.

### ۱-۱. دانلود باینری واتروال

نسخه هدف **1.46.96** است.

```
https://github.com/radkesvat/WaterWall/releases/tag/v1.46.96
```

نام فایل zip بر اساس معماری CPU فرق می‌کند:

| معماری | فایل |
| --- | --- |
| x86-64 معمولی | `Waterwall-linux-gcc-x64.zip` |
| x86-64 قدیمی (بدون AVX) | `Waterwall-linux-gcc-x64-old-cpu.zip` |
| ARM64 | `Waterwall-linux-gcc-arm64.zip` |

> ⚠️ **دو نکته مهم که معمولاً باعث خطا می‌شوند:**
>
> 1. نام مخزن `WaterWall` است ولی **نام فایل‌های انتشار `Waterwall`** با حرف w کوچک. این تفاوت باعث ۴۰۴ می‌شود.
> 2. اگر CPU شما AVX ندارد و فایل `x64` را بگیرید، واتروال هنگام اجرا با خطای illegal instruction می‌میرد. در آن حالت `-old-cpu` را بگیرید.

بررسی AVX روی سرور:

```bash
grep -o -m1 -w 'avx' /proc/cpuinfo || echo "بدون AVX -> فایل -old-cpu را بگیرید"
```

### ۱-۲. دانلود فایل ایجنت

از ریپوزیتوری پنل:

```
https://raw.githubusercontent.com/alimc98/waterwall-panel/main/agent/agent.js
```

### ۱-۳. کپی به سرور

```bash
# از کامپیوتر خودتان
scp Waterwall-linux-gcc-x64-old-cpu.zip root@IRAN_IP:/root/
scp agent.js root@IRAN_IP:/root/

# برای سرور خارج هم همین کار را بکنید
scp Waterwall-linux-gcc-x64-old-cpu.zip root@{FOREIGN_IP}:/root/
scp agent.js root@{FOREIGN_IP}:/root/
```

اگر SSH هم ندارید، از کنسول ارائه‌دهنده سرور (VNC/console) استفاده کنید و فایل‌ها را با یک درایو یا رابط وب آپلود کنید.

### نکته: فقط یکی از دو سرور لازم دارد فایل بگیرد

اگر یکی از سرورها به اینترنت دسترسی دارد ولی دیگری ندارد، نصب را روی آن یکی انجام دهید و بعد پوشه `/opt/waterwall` را کپی کنید:

```bash
# روی سروری که به اینترنت دسترسی دارد
tar czf /root/waterwall.tar.gz -C /opt waterwall

scp /root/waterwall.tar.gz root@{OTHER_IP}:/root/
```

---

## مرحله ۲: نصب باینری

این دستورات را **روی هر دو سرور** اجرا کنید.

### ۲-۱. بررسی فایل

```bash
cd /root
ls -la Waterwall-linux-*.zip agent.js
```

### ۲-۲. ساخت پوشه‌ها

```bash
install -d -m 0755 /opt/waterwall
install -d -m 0755 /opt/waterwall/configs
install -d -m 0755 /opt/waterwall/log
```

### ۲-۳. استخراج و نصب

```bash
unzip -o Waterwall-linux-gcc-x64-old-cpu.zip -d /tmp/ww-extract
ls -la /tmp/ww-extract
```

خروجی باید یک فایل به نام **`Waterwall`** باشد.

```bash
install -m 0755 /tmp/ww-extract/Waterwall /opt/waterwall/Waterwall
```

### ۲-۴. تأیید

```bash
ls -la /opt/waterwall/Waterwall
file /opt/waterwall/Waterwall          # باید ELF 64-bit باشد
/opt/waterwall/Waterwall --version     # باید شماره نسخه را چاپ کند
```

اگر `--version` نسخه را چاپ نکرد نگران نباشید؛ بعضی نسخه‌ها این سوییچ را ندارند. مهم این است که فایل اجرا شود.

### بدون unzip

اگر `unzip` نصب نیست، یکی از این‌ها:

```bash
# با پایتون
python3 -c "import zipfile; zipfile.ZipFile('/root/Waterwall-linux-gcc-x64-old-cpu.zip').extractall('/tmp/ww-extract')"

# یا نصب unzip
apt-get update && apt-get install -y unzip      # دبیان/اوبونتو
yum install -y unzip                           # راپت/فدورا
apk add --no-cache unzip                      # آلپاین
```

اگر هیچ‌کدام نبود، در `busybox` هست:

```bash
busybox unzip -o /root/Waterwall-linux-gcc-x64-old-cpu.zip -d /tmp/ww-extract
```

---

## مرحله ۳: تنظیم سیستم

این‌ها اختیاری‌اند ولی **جدی توصیه می‌شوند**. بدون آن‌ها، تونل‌های پرترافیک با خطای «too many open files» یا قطعی ناگهانی می‌میرند.

### ۳-۱. sysctl

```bash
cat > /etc/sysctl.d/99-waterwall.conf <<'EOF'
# WaterWall tuning
net.core.somaxconn = 8192
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.ip_local_port_range = 10240 65000
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_congestion_control = bbr
fs.file-max = 1048576
EOF

sysctl --system
```

بررسی:

```bash
sysctl net.core.somaxconn net.ipv4.tcp_congestion_control
```

اگر `bbr` در دسترس نبود:

```bash
modprobe tcp_bbr
sysctl -w net.ipv4.tcp_congestion_control=bbr
```

### ۳-۲. limits

```bash
cat > /etc/security/limits.d/99-waterwall.conf <<'EOF'
*      soft  nofile  1048576
*      hard  nofile  1048576
root   soft  nofile  1048576
root   hard  nofile  1048576
EOF
```

> این فایل روی سرویس systemd اثر **ندارد**. برای آن، `LimitNOFILE` را داخل یونیت سرویس می‌گذاریم (مرحله ۴).

---

## مرحله ۴: سرویس systemd

### ۴-۱. ساخت فایل یونیت

```bash
cat > /etc/systemd/system/waterwall.service <<'EOF'
[Unit]
Description=WaterWall
Documentation=https://github.com/radkesvat/WaterWall
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/waterwall
ExecStart=/opt/waterwall/Waterwall
Restart=always
RestartSec=5
LimitNOFILE=1048576
LimitNPROC=infinity

[Install]
WantedBy=multi-user.target
EOF
```

> ⚠️ `ExecStart` باید دقیقاً `/opt/waterwall/Waterwall` باشد — با **w کوچک**. لینوکس به حروف حساس است. اگر فایل را به `WaterWall` تغییر نام داده‌اید، این خط را هم همان‌طور تغییر دهید.

> 💡 اگر فایل را جابه‌جا کردید، می‌توانید از فرم صریح استفاده کنید:
> ```
> ExecStart=/opt/waterwall/Waterwall --config:/opt/waterwall/core.json
> ```
> بدون هیچ آرگومانی هم کار می‌کند، چون واتروال `./core.json` را از پوشه جاری می‌خواند.

### ۴-۲. فعال‌سازی

```bash
systemctl daemon-reload
systemctl enable waterwall.service
```

**فعلاً start نکنید.** واتروال بدون فایل `core.json` بلافاصله خارج می‌شود و یونیت مدام ری‌استارت می‌شود. اول کانفیگ را از پنل بفرستید.

### ۴-۳. بررسی یونیت

```bash
systemctl cat waterwall.service
systemctl status waterwall.service
```

---

## مرحله ۵: نصب ایجنت (اختیاری ولی توصیه‌شده)

ایجنت باعث می‌شود پنل بتواند کانفیگ را روی سرور بنویسد و سرویس را ری‌استارت کند، بدون اینکه SSH باز بماند.

اگر نمی‌خواهید ایجنت نصب کنید، **این مرحله را رد کنید** و از قابلیت SSH خود پنل استفاده کنید.

### ۵-۱. بررسی Node.js

```bash
command -v node && node -v
```

اگر نصب نیست:

```bash
apt-get update && apt-get install -y nodejs       # دبیان/اوبونتو
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs   # نسخه ۲۲
```

**حداقل نسخه ۱۸** لازم است.

### ۵-۲. کپی فایل ایجنت

```bash
install -d -m 0755 /opt/ww-agent
install -d -m 0755 /var/lib/ww-agent
install -m 0755 /root/agent.js /opt/ww-agent/agent.js
```

### ۵-۳. گرفتن توکن از پنل

در پنل: **سرورها → افزودن سرور**. بعد از ساخت، فیلد **Agent Token** را کپی کنید.

هر سرور **توکن جداگانه** دارد. اگر توکن را از دست دادید، در پنل سرور را حذف و دوباره بسازید.

### ۵-۴. ساخت یونیت ایجنت

```bash
cat > /etc/systemd/system/ww-agent.service <<EOF
[Unit]
Description=WaterWall Panel agent
After=network-online.target waterwall.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ww-agent
ExecStart=$(command -v node) /opt/ww-agent/agent.js
Restart=always
RestartSec=5
Environment=WW_PANEL_URL=https://PANEL_ADDRESS
Environment=WW_AGENT_TOKEN=PASTE_TOKEN_HERE
Environment=WW_INTERVAL=15
Environment=WW_WATERWALL_PATH=/opt/waterwall
Environment=WW_SERVICE=waterwall
Environment=WW_STATE_DIR=/var/lib/ww-agent

[Install]
WantedBy=multi-user.target
EOF
```

قبل از `systemctl start`، دو مقدار را جایگزین کنید:

- `PANEL_ADDRESS` — آدرس پنل با `http://` یا `https://`. **بدون** اسلش انتهایی.
- `PASTE_TOKEN_HERE` — توکنی که از پنل کپی کردید.

> ⚠️ توکن در فایل یونیت به‌صورت متن ساده ذخیره می‌شود. روی سرور مشترک، دسترسی این فایل را محدود کنید:
> ```bash
> chmod 600 /etc/systemd/system/ww-agent.service
> ```

### ۵-۵. اجرا

```bash
systemctl daemon-reload
systemctl enable --now ww-agent.service
systemctl status ww-agent.service
journalctl -u ww-agent -f
```

باید لاگ اتصال موفق به پنل را ببینید. اگر `401` دیدید، توکن اشتباه است.

---

## مرحله ۶: فرستادن اولین کانفیگ

### روش الف: از طریق پنل (توصیه‌شده)

1. در پنل **سرورها** را ثبت کنید:
   - نام، نقش (`ایران` / `خارج`)، آدرس IP، مسیر واتروال (`/opt/waterwall`)
   - **Agent Token** را همانی بگذارید که در مرحله ۵-۳ گرفتید
2. **تونل جدید** بسازید
3. **استقرار** را بزنید

ایجنت کانفیگ را می‌نویسد و سرویس را ری‌استارت می‌کند.

### روش ب: بدون پنل و بدون ایجنت

فایل‌های تولیدشده را از پنل دانلود کنید و دستی بفرستید:

```bash
# ساختار لازم روی سرور
/opt/waterwall/
├── Waterwall              ← باینری
├── core.json              ← تنظیمات هسته
├── configs/
│   └── tunnel.json        ← کانفیگ نودها
└── log/
```

```bash
scp core.json root@IRAN_IP:/opt/waterwall/
scp tunnel.json root@IRAN_IP:/opt/waterwall/configs/

systemctl restart waterwall
journalctl -u waterwall -n 50 --no-pager
```

### ساختار `core.json`

```json
{
  "misc": {
    "workers": 4,
    "ram-profile": "server",
    "mtu": 1500,
    "log-level": "INFO",
    "network-log-level": "INFO",
    "domain-strategy": "prefer-ipv4",
    "splice": true,
    "bbr": true
  },
  "servers": ["configs/tunnel.json"],
  "logs": {
    "directory": "log"
  }
}
```

> `misc.workers` را با تعداد هسته تنظیم کنید. برای سرور ایران معمولاً `client` و برای سرور خارج `server` مناسب است.

---

## مرحله ۷: تست

### ۷-۱. سرویس بالا آمده؟

```bash
systemctl is-active waterwall
journalctl -u waterwall -n 50 --no-pager
```

خروجی سالم چیزی شبیه این است:

```
[INFO] Waterwall v1.46.96
[INFO] loaded 1 node config
[INFO] started 4 workers
```

### ۷-۲. پورت‌ها گوش می‌دهند؟

```bash
ss -lntup | grep -E 'Waterwall|waterwall'
```

پورت کاربران و پورت لینک باید دیده شوند.

### ۷-۳. از سرور مقابل وصل شو

```bash
# از سرور خارج به پورت لینک سرور ایران
nc -zv IRAN_IP 2053

# از سرور ایران به پورت کاربران
nc -zv 127.0.0.1 443
```

### ۷-۴. ایجنت وصل است؟

```bash
journalctl -u ww-agent -n 30 --no-pager
```

در پنل، ستون **نسخه واتروال** باید پر شده باشد.

---

## عیب‌یابی

### `Illegal instruction` هنگام اجرا

CPU شما AVX ندارد ولی فایل `x64` را نصب کرده‌اید.

```bash
grep -o -w 'avx' /proc/cpuinfo || echo "بدون AVX"
```

درستی: فایل `-old-cpu` را دوباره نصب کنید:

```bash
unzip -o Waterwall-linux-gcc-x64-old-cpu.zip -d /tmp/ww-extract
install -m 0755 /tmp/ww-extract/Waterwall /opt/waterwall/Waterwall
systemctl restart waterwall
```

### سرویس مدام ری‌استارت می‌شود

```bash
systemctl status waterwall
journalctl -u waterwall -n 100 --no-pager
```

دلیل رایج: فایل `core.json` وجود ندارد یا خراب است.

```bash
cat /opt/waterwall/core.json
python3 -m json.tool /opt/waterwall/core.json > /dev/null && echo "JSON سالم"
```

### `Permission denied` روی پورت زیر ۱۰۲۴

پورت‌های زیر ۱۰۲۴ نیاز به root دارن، ولی واتروال باید با `AmbientCapabilities` اجرا شود:

```bash
# به یونیت اضافه کنید
systemctl edit waterwall.service
```

```ini
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_ADMIN CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_ADMIN CAP_NET_RAW
```

```bash
systemctl daemon-reload && systemctl restart waterwall
```

> `CAP_NET_ADMIN` و `CAP_NET_RAW` فقط برای تونل‌هایی لازم‌اند که `RawSocket` دارند: bit-swap، protoswap، first-sni، sni-blender، ping-tunnel.

### خطای کانفیگ هنگام اجرا

```bash
journalctl -u waterwall -n 100 --no-pager | grep -i error
```

پیام خطا معمولاً **نام دقیق تنظیم** را می‌آورد. پنل این‌ها را قبل از استقرار می‌گیرد — ولی اگر کانفیگ را دستی ساخته‌اید، جدول تنظیمات حذف‌شده در README را ببینید.

### نسخه در پنل «نامشخص» است

ایجنت نتوانسته نسخه را بخواند.

```bash
/opt/waterwall/Waterwall --version
ls -la /opt/waterwall/Waterwall
```

اگر باینری نام دیگری دارد (مثلاً `WaterWall`)، پنل هر دو را امتحان می‌کند ولی یونیت باید به نام واقعی اشاره کند.

### ایجنت کانفیگ را نمی‌گیرد

```bash
systemctl status ww-agent
journalctl -u ww-agent -n 50 --no-pager
```

| پیام | مشکل |
| --- | --- |
| `401` | توکن اشتباه |
| `ENOTFOUND` / `ECONNREFUSED` | آدرس پنل غلط یا فایروال |
| `no route to host` | سرور به پنل دسترسی ندارد |
| `channel closed` | پنل خاموش است |

### پورت در فایروال باز نیست

```bash
# اوبونتو با ufw
ufw allow 443/tcp
ufw allow 2053/tcp
ufw status

# یا
iptables -L -n | grep 443
```

**پورت لینک را فقط برای IP سرور مقابل باز کنید:**

```bash
ufw allow from FOREIGN_IP to any port 2053 proto tcp
```

---

## نصب روی معماری ARM

```bash
uname -m                            # باید aarch64 باشد
unzip -o Waterwall-linux-gcc-arm64.zip -d /tmp/ww-extract
install -m 0755 /tmp/ww-extract/Waterwall /opt/waterwall/Waterwall
```

بقیه مراحل یکسان است.

اگر ARM ندارید و فایل آماده‌ای پیدا نمی‌کنید، از سورس بسازید — ولی به cmake، ninja و build-essential نیاز دارد:

```bash
apt-get purge -y cmake
apt-get update
apt-get install -y snapd build-essential ninja-build ccache
snap install cmake --classic

git clone https://github.com/radkesvat/WaterWall && cd WaterWall
cmake --preset linux-gcc-arm64 && cmake --build --preset linux-gcc-arm64
```

---

## فهرست چک نهایی

```bash
echo "1. باینری:"
test -x /opt/waterwall/Waterwall && echo "   ok" || echo "   MISSING"

echo "2. پوشه‌ها:"
test -d /opt/waterwall/configs && echo "   ok" || echo "   MISSING"

echo "3. یونیت:"
systemctl is-enabled waterwall.service

echo "4. کانفیگ:"
test -f /opt/waterwall/core.json && echo "   ok" || echo "   not deployed yet"

echo "5. سرویس:"
systemctl is-active waterwall

echo "6. ایجنت:"
systemctl is-active ww-agent 2>/dev/null || echo "   not installed (optional)"

echo "7. پورت‌ها:"
ss -lntup | grep -c Waterwall
```

---

## خلاصه در یک بلوک

```bash
# --- روی کامپیوتر خودتان ---
# دانلود: Waterwall-linux-gcc-x64-old-cpu.zip و agent.js

# --- روی هر سرور ---
install -d -m 0755 /opt/waterwall /opt/waterwall/configs /opt/waterwall/log
unzip -o ~/Waterwall-linux-gcc-x64-old-cpu.zip -d /tmp/ww
install -m 0755 /tmp/ww/Waterwall /opt/waterwall/Waterwall

cat > /etc/systemd/system/waterwall.service <<'EOF'
[Unit]
Description=WaterWall
After=network-online.target
[Service]
Type=simple
WorkingDirectory=/opt/waterwall
ExecStart=/opt/waterwall/Waterwall
Restart=always
RestartSec=5
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload && systemctl enable waterwall.service
```

بعد از این، از پنل کانفیگ بفرستید و `systemctl start waterwall`.