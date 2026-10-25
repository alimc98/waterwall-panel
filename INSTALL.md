# راهنمای نصب WaterWall Panel — مرحله به مرحله

این مستند نصب و پیکربندی کامل پنل WaterWall را توضیح می‌دهد. پنل یک برنامه Node.js است (بدون وابستگی بیرونی) که تونل‌های Reverse Reality را روی سرورهای role دار می‌سازد، پیکربندی می‌کند و نظارت می‌کند.

## فهرست مطالب
1. [پیش‌نیازها](#پیش‌نیازها)
2. [نصب سرور پنل (Iran Panel)](#نصب سرور پنل-iran-panel)
3. [نصب Waterwall روی سرورهای role دار](#نصب-waterwall-روكسروارو-رoldown-رoldown)
4. [ایجاد تونل از طریق پنل](#ایجاد تونل-از-طریق-پنل)
5. [اعمال پیکربندی (Apply) روی تونل‌ها](#اعمال پیکربندی-apply-روكسروارو-رoldown-رoldown)
6. [بررسی سلامت تونل‌ها](#بررسی سلامت تونل‌ها)
7. [فیکس‌ها و بازسازی از assessments قبلی](#فیکس‌ها-و-بازسازی-از-assessments-قبلی)

---

## 1. پیش‌نیازها

| مورد | جزئیات |
|------|--------|
| سرور پنل | Ubuntu/Debian، 1 vCPU+1GB RAM حداقل، IP pública |
| سرورهای role دار | ایران (Arvan/Asiatech)، لندن (UK)، رومانی، ایالات متحده (USA) |
| کاربر سرور | `root` با دسترسی SSH یا sudo کامل |
| Node.js | v20+ (نصب شده در `/opt/node20` روی سرور پنل) |
| 포트‌های firewall | 8787 (پنل)، 443/8443 (تونل)، 22 (SSH) |
| دسکتوب desarrollo | Git، Node.js (برای push کد) |

> سرور USA (`192.227.211.124`) هنوز Waterwall نصب نشده است — بخش ۳ را برای این سرور انجام دهید.

---

## 2. نصب سرور پنل (Iran Panel)

سرور پنل روی `188.121.106.83` اجرا می‌شود.

### ۲.۱ کلون کردن مخزن
```bash
ssh root@188.121.106.83
cd /opt
git clone https://github.com/alimc98/waterwall-panel.git waterwall-panel
cd waterwall-panel
```

### ۲.۲ نصب وابستگی‌ها و ساخت
```bash
# استفاده از Node.js 20 که در /opt/node20 قرار دارد
/opt/node20/bin/npm ci
/opt/node20/bin/npm run build   # اگر اسکریپت build وجود داشته باشد
```

### ۲.۳ تنظیم سرویس systemd
فایل سرویس را در `/etc/systemd/system/waterwall-panel.service` بسازید:

```ini
[Unit]
Description=WaterWall Control Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/waterwall-panel
ExecStart=/opt/node20/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=8787

[Install]
WantedBy=multi-user.target
```

سرویس را فعال و استارت کنید:
```bash
systemctl daemon-reload
systemctl enable waterwall-panel.service
systemctl start waterwall-panel.service
systemctl status waterwall-panel.service
```

پنل روی `http://188.121.106.83:8787` در دسترس می‌شود.

### ۲.۴ توکن دسترسی به API
با ورود به پنل در مرورگر، توکن API را از بخش تنظیمات کپی کنید. هر درخواست به API نیاز به هدر دارد:

```
Authorization: Bearer <TOKEN>
```

---

## 3. نصب Waterwall روی سرورهای role دار

Waterwall باینری و واحد systemd را باید روی هر سرور role دار نصب کنید. این کار از طریق API پنل صورت می‌گیرد (نه SSH دستی).

### ۳.۱ فهرست سرورها
```bash
curl -s -H "Authorization: Bearer <TOKEN>" \
  http://188.121.106.83:8787/api/servers | python3 -m json.tool
```

سرورهایمنتظره:
- `eb51e3e2-b7a8-4d1d-ad46-51e973447cad` — Arvan Iran (`188.121.106.83`)
- `f66e0a5d-28c9-4fcf-9cb2-cb7e74856376` — Asiatech Afagh Iran (`94.184.37.126`)
- `96dc29fe-c193-46aa-904e-69ef7386457d` — London/UK (`85.121.120.43`)
- `da665af9-f743-469a-83bd-5cc340bdbb47` — Romania (`45.13.38.166`)
- `192.227.211.124` — USA (بدون Waterwall، نیاز به نصب)

### ۳.۲ نصب Waterwall روی هر سرور
برای هر `SERVER_ID`، درخواست install را بفرستید:

```bash
curl -s -X POST -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"force": true}' \
  http://188.121.106.83:8787/api/servers/<SERVER_ID>/install
```

پاسخ موفق شامل موارد زیر است:
- `"ok": true`
- `"installed": ["/opt/waterwall/Waterwall"]` — باینری Waterwall
- `"unit": "/etc/systemd/system/waterwall.service"` — واحد systemd
- `"serviceName": "waterwall"` — نام سرویس

> روی România باینری `old-cpu` نصب می‌شود (عدم پشتیبانی AVX2) — این رفتار مورد انتظار است و Bug نیست.

### ۳.۳ بررسی نصب
```bash
ssh root@<SERVER_IP>
systemctl is-active waterwall.service
ls -l /opt/waterwall/Waterwall
```

خروجی باید `active` باشد و باینری قابل اجرا باشد.

---

## 4. ایجاد تونل از طریق پنل

تونل Reverse Reality می‌سازد که تrafic را از سرور خارج (Foreign) به سرور ایران (Entry) می‌فرستد.

### ۴.۱ payload ایجاد تونل
متناظر با قالب `reverse-reality` در `lib/templates/reverse-reality.js`:

```json
{
  "name": "Reverse Reality Arvan UK",
  "template": "reverse-reality",
  "targetServers": ["<SERVER_ID_IRAN>"],
  "foreign": ["<SERVER_ID_UK>", "<SERVER_ID_ROMANIA>"],
  "settings": {
    "listenPort": 443,
    "targetPort": 443
  }
}
```

مثال برای تونل Arvan UK (لندن اول، رومانی دوم):
```bash
curl -s -X POST -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Reverse Reality Arvan UK",
    "template": "reverse-reality",
    "targetServers": ["eb51e3e2-b7a8-4d1d-ad46-51e973447cad"],
    "foreign": ["96dc29fe-c193-46aa-904e-69ef7386457d", "da665af9-f743-469a-83bd-5cc340bdbb47"],
    "settings": {"listenPort": 443, "targetPort": 443}
  }' \
  http://188.121.106.83:8787/api/tunnels
```

پاسخ شامل `id` تونل است (مثلاً `1f2942cf-...`).

### ۴.۲ ترتیب خروجی‌های تونل
ترتیب آرایه `foreign` ترتیب خروجی‌های تونل را تعیین می‌کند:
- `foreign[0]` = خارج اول (لندن)
- `foreign[1]` = خارج دوم (رومانی)

این ترتیب در پیکربندی تولیدی (`ip_server_kharej`) حفظ می‌شود.

---

## 5. اعمال پیکربندی (Apply) روی تونل‌ها

پس از ایجاد تونل، باید پیکربندی را روی همه سرورهای role دار اعمال کنید:

```bash
curl -s -X POST -H "Authorization: Bearer <TOKEN>" \
  http://188.121.106.83:8787/api/tunnels/<TUNNEL_ID>/apply
```

پاسخ شامل:
- `"iran.ok": true` — پیکربندی روی سرور ایران آپلود و سرویس فعال شد
- `"foreign.servers[].ok": true` — هر سرور خارج پیکربندی را دریافت کرد
- `"reachability.ok": true` — دسترسی 443 در هر دو جهت باز است
- `"service.output": "active"` — سرویس Waterwall فعال است

---

## 6. بررسی سلامت تونل‌ها

```bash
# لیست تونل‌ها
curl -s -H "Authorization: Bearer <TOKEN>" \
  http://188.121.106.83:8787/api/tunnels | python3 -m json.tool

# بررسی وضعیت سرویس روی هر سرور
ssh root@188.121.106.83 "systemctl is-active waterwall.service"
ssh root@85.121.120.43 "systemctl is-active waterwall.service"
ssh root@45.13.38.166 "systemctl is-active waterwall.service"
ssh root@94.184.37.126 "systemctl is-active waterwall.service"
```

تونل‌های فعال در شبکه فعلی:
| تونل | ID | ایران | خارج ۱ | خارج ۲ | وضعیت |
|------|-----|-------|--------|--------|-------|
| Reverse Reality Arvan UK | `1f2942cf` | Arvan Iran | London/UK | Romania | Apply شد، 443 open |
| Reverse Reality Asiatech Afagh RO | `6451a69d` | Asiatech Afagh | Romania | — | Apply شد، 443 open |

---

## 7. فیکس‌ها و بازسازی از assessments قبلی

### ۷.۱ باگ NO_BINARY (پوشهٔ خالی باقی‌مانده)
**مشکل:** وقتی Waterwall باینری روی سرور یافت نمی‌شد (`NO_BINARY`)، شاخهٔ نصب پوشهٔ `/opt/waterwall-X` خالی را achter نمی‌گرفت → پوشهٔ خالی روی România باقی می‌ماند.

**فیکس در `lib/ssh.js`:**
```bash
CREATED=no
if [ ! -d "$BASE" ]; then CREATED=yes; fi
# ... در شاخهٔ NO_BINARY قبل از exit 3:
if [ "$CREATED" = yes ]; then rm -rf "$BASE"; fi
```

تست رگرسیون در `test/maintenance.test.js` اضافه شد: "a clone that finds no binary leaves no directory behind".

### ۷.۲ باگ ترتیب/swap در خروجی تونل
**مشکل:** ترتیب سرورهای خارج در پیکربندی تولیدی با ترتیب ذخیره‌شده مطابقت نداشت.

**نتیجه بررسی:** `ip_server_kharej` در کانفیگ ایران ترتیب ذخیره‌شده را حفظ می‌کند (英國 اول). باگ در مسیر build/clone نبود، بلکه در نحوه ارسال `foreign` به API بود. اصلاح با لیست صریح و مرتب `targetServers`/`foreign` در هنگام ایجاد تونل.

### ۷.۳ بازبینی سورس
تمام فایل‌های کلیدی (`lib/ssh.js`, `lib/store.js`, `lib/util.js`, `public/app.js`, `server.js`, `agent/agent.js`) توسط sub-agents بازبینی شدند (فقط گزارش، بدون تغییر فایل). ۱۹۶ تست (`npm test`) پاس می‌کنند.

---

## 8. نصب Waterwall روی سرور USA (جدید)

سرور `192.227.211.124` هنوز Waterwall نصب نشده است. مراحل:

```bash
# ۱. از طریق پنل، سرور USA را به فروشگاه سرورها اضافه کنید (در صورت نیاز)
# ۲. نصب Waterwall از طریق API
curl -s -X POST -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"force": true}' \
  http://188.121.106.83:8787/api/servers/<SERVER_ID_USA>/install

# ۳. بررسی
ssh root@192.227.211.124 "systemctl is-active waterwall.service"
```

---

## ۹. پرسش و پاسخoperators

**س: چرا سرور USA水壁 نصب نیست؟**
**ج:** سرور USA جدید به لیست اضافه شده است و هنوز درخواست install برای آن ارسال نشده. بخش ۸ را انجام دهید.

**س: پوشهٔ `/opt/waterwall-3` روی románیا چه شده است؟**
**ج:** این پوشهٔ remnants از assessments قبلی بود. فیکس `lib/ssh.js` (CREATED/rm -rf) آن را برطرف می‌کند و تست رگرسیون وجود دارد.

**س: آیا می‌توانم کد را روی GitHub ببینم؟**
**ج:** بله، کد آخرین نسخه در `https://github.com/alimc98/waterwall-panel.git` روی شاخه `main` قرار دارد (commit `555e32c`).

---

## ۱۰. امنیت

- هیچ رمز، توکن یا секрет در کد، کامیت یا مستندات ثبت نمی‌شود.
- توکن API فقط در هدر `Authorization: Bearer <TOKEN>` ارسال می‌شود (نه query param).
- رمز SSH هرگز در کد یا کامیت ثبت نمی‌شود.
