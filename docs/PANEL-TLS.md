# گواهی و دامنه برای پنل WaterWall

پنل خودش HTTPS سرو نمی‌کند (فقط HTTP روی `WW_PANEL_HOST`). برای دامنه و گواهی، یک reverse proxy (Caddy یا nginx) جلوی پنل بگذارید.

## پیش‌نیاز
- DNS رکورد `A` دامنه (مثلاً `panel.example.com`) به IP سرور ایران (`188.121.106.83`).
- پنل روی loopback bind شده باشد:
  ```bash
  # /etc/waterwall-panel.env یا systemd unit
  WW_PANEL_HOST=127.0.0.1
  WW_PANEL_PORT=8787
  systemctl restart waterwall-panel
  ```

## روش ۱: Caddy (توصیه می‌شود)
Caddy گواهی Let’s Encrypt را خودکار می‌گیرد.

1. نصب:
   ```bash
   apt-get update
   apt-get install -y caddy
   ```
2. `/etc/caddy/Caddyfile`:
   ```caddy
   panel.example.com {
       reverse_proxy 127.0.0.1:8787
   }
   ```
3. راه‌اندازی:
   ```bash
   caddy validate --config /etc/caddy/Caddyfile
   systemctl restart caddy
   systemctl enable caddy
   ```

## روش ۲: nginx + certbot
1. نصب:
   ```bash
   apt-get install -y nginx certbot python3-certbot-nginx
   ```
2. `/etc/nginx/sites-available/panel`:
   ```nginx
   server {
       listen 80;
       server_name panel.example.com;
       location / {
           proxy_pass http://127.0.0.1:8787;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header X-Forwarded-For $remote_addr;
       }
   }
   ```
3. فعال‌سازی:
   ```bash
   ln -s /etc/nginx/sites-available/panel /etc/nginx/sites-enabled/panel
   nginx -t
   systemctl restart nginx
   certbot --nginx -d panel.example.com
   ```

## فایروال
- پورت `443` را باز بگذارید.
- پورت `8787` را ببندید (فقط loopback).
- پورت `22` را برای SSH باز نگه دارید.

## نکات
- گواهی پنل (برای UI/API) با گواهی تونل‌ها (برای سرورهای خارج) جداست.
- پنل خودش از گواهی استفاده نمی‌کند؛ proxy گواهی را terminate می‌کند.
- اگر panel را روی 0.0.0.0 باز گذاشته‌اید، حتماً bind را به 127.0.0.1 تغییر دهید.