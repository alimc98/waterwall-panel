# HAProxy جلوی WaterWall روی پورت 443

این راهنما برای وقتی است که می‌خواهید چند تونل WaterWall روی یک سرور ایران داشته باشید و همهٔ آن‌ها از بیرون روی پورت `443` (HTTPS) دیده شوند، بدون اینکه پورت‌های داخلی WaterWall بیرون باز باشند.

## ایده
- WaterWall هر تونل را روی یک پورت داخلی (مثلاً `8443`, `8444`) و روی `127.0.0.1` می‌گذارد.
- HAProxy روی `0.0.0.0:443` گوش می‌دهد و با `mode tcp` ترافیک TLS را **بدون terminate کردن** (SNI passthrough) به بک‌اند مناسب می‌فرستد.
- چون HAProxy TLS را خاتمه نمی‌دهد، گواهی/کلید لازم نیست و Reality خودش دست‌دادن TLS را انجام می‌دهد.

## پیش‌نیاز مهم: تشخیص تونل‌ها
HAProxy برای جدا کردن تونل‌ها به یک تفاوت در ClientHello نیاز دارد. ساده‌ترین راه: برای هر تونل یک `realitySni` / `camouflageHost` **متفاوت** انتخاب کنید (مثلاً `www.microsoft.com`, `www.apple.com`). در غیر این صورت HAProxy نمی‌تواند تونل‌ها را از هم جدا کند و باید از پورت‌های مختلف استفاده کنید.

## ۱. تنظیم تونل‌ها در پنل
برای هر تونل:
- `listenAddress` را `127.0.0.1` بگذارید.
- `userPort` و `reversePort` را یک پورت داخلی منحصر (مثلاً `8443`) بگذارید.
- `samePort` را روشن بگذارید.
- `camouflageHost` / `realitySni` را برای هر تونل متفاوت انتخاب کنید.

Apply کنید تا WaterWall روی `127.0.0.1:8443` بالا بیاید.

## ۲. نصب HAProxy
```bash
apt-get update
apt-get install -y haproxy
```

## ۳. کانفیگ HAProxy
فایل `/etc/haproxy/haproxy.cfg` را به شکل زیر تنظیم کنید (پورت‌ها و SNIها را با تونل‌های خودتان هماهنگ کنید):

```haproxy
global
    log /dev/log local0
    maxconn 4096

defaults
    mode tcp
    timeout connect 5s
    timeout client  30s
    timeout server  30s

frontend tls_in
    bind *:443
    mode tcp
    tcp-request inspect-delay 5s
    tcp-request content accept if { req_ssl_hello_type 1 }

    acl sni_ms req_ssl_sni -i www.microsoft.com
    acl sni_apple req_ssl_sni -i www.apple.com

    use_backend bw_ms if sni_ms
    use_backend bw_apple if sni_apple
    default_backend bw_ms

backend bw_ms
    mode tcp
    server w1 127.0.0.1:8443

backend bw_apple
    mode tcp
    server w2 127.0.0.1:8444
```

سپس:
```bash
haproxy -c -f /etc/haproxy/haproxy.cfg
systemctl restart haproxy
systemctl enable haproxy
```

## ۴. فایروال
- پورت `443` را باز بگذارید.
- پورت‌های `8443`, `8444` را **فقط روی loopback** نگه دارید (پیش‌فرض WaterWall روی `127.0.0.1` bind می‌کند).
- اگر WaterWall را روی `0.0.0.0` گذاشته‌اید، حتماً با فایروال آن پورت‌ها را ببندید.

## UDP
HAProxy در `mode tcp` فقط TCP را پروکسی می‌کند. برای UDP یکی از این راه‌ها را انتخاب کنید:
- از قالب `udp-over-tcp` پنل استفاده کنید تا UDP داخل تونل TCP عبور کند و روی `443` دیده شود.
- یا یک UDP proxy جداگانه (مثلاً `socat` یا `nginx stream` با `udp`) برای پورت UDP تنظیم کنید.

## عیب‌یابی
- اگر HAProxy بالا نیامد: `haproxy -c -f /etc/haproxy/haproxy.cfg` را اجرا کنید.
- اگر تونل وصل نشد: مطمئن شوید `realitySni` هر تونل با ACL مربوطه در HAProxy یکی است.
- اگر DPI همچنان تشخیص می‌دهد: مسیر واقعی (`camouflageHost`) باید یک سایت واقعی و در دسترس از سرور ایران باشد.