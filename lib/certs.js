'use strict';

/**
 * TLS certificate management.
 *
 * Most TLS templates need a certificate on the exit box, and until now the only
 * way to get one was to hand-write it onto the server by hand. This issues them
 * from the panel: give it a domain and it either gets a real Let's Encrypt
 * certificate, or falls back to a self-signed one that works immediately for
 * clients that do not verify.
 *
 * Design notes:
 *  - Certificates live at a single managed path, /etc/waterwall/cert. Templates
 *    read their paths from options so the panel and the core never disagree.
 *  - Issuance runs on the *exit* server, because that is where TlsServer lives.
 *  - Nothing is stored but metadata; the key never comes back to the panel.
 *  - Renewal is checked on read, so an expiring certificate shows a warning
 *    before it breaks a running tunnel.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { shellQuote } = require('./ssh');

/** The one place certificates live. Every template points here. */
/** Directory a managed file lives in, so `install -d` creates the right parent. */
function dirOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : CERT_DIR;
}

const CERT_DIR = '/etc/waterwall/cert';
const CERT_PATH = `${CERT_DIR}/fullchain.pem`;
const KEY_PATH = `${CERT_DIR}/privkey.pem`;

/** Renewal window: a certificate inside this is treated as needing renewal. */
const RENEW_WITHIN_DAYS = 30;

const SELF_SIGNED_DAYS = 825; // the maximum browsers accept, and the usual internal practice

// ------------------------------------------------------------------ helpers

/**
 * Trim and lowercase only.
 *
 * Whitespace is deliberately *not* stripped from the inside: removing it would
 * turn a typo like "exam ple.com" into "example.com" and quietly issue a
 * certificate for a domain the user never typed. Internal whitespace is a
 * rejection, handled in validateDomain.
 */
function normaliseDomain(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

/**
 * Reject anything that is not a plausible hostname.
 *
 * This value ends up in an openssl -subj and, for Let's Encrypt, in a command
 * line on a remote host, so it must never be able to carry shell syntax.
 */
function validateDomain(input) {
  const domain = normaliseDomain(input);
  if (!domain) return { ok: false, domain, error: 'دامنه خالی است' };
  // Catch embedded whitespace explicitly, since a stray space is a typo and not
  // something to silently repair.
  if (/\s/.test(domain)) return { ok: false, domain, error: 'دامنه نباید فاصله داشته باشد' };
  if (domain.length > 253) return { ok: false, domain, error: 'دامنه خیلی بلند است' };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return { ok: false, domain, error: 'دامنه معتبر نیست؛ فقط حروف، عدد، خط تیره و نقطه' };
  }
  return { ok: true, domain, error: null };
}

function fingerprint(sha256OrFingerprint) {
  return String(sha256OrFingerprint || '')
    .replace(/^SHA256:/, '')
    .slice(0, 32);
}

function daysUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
}

function statusOf(cert) {
  const days = daysUntil(cert.notAfter);
  if (days === null) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= RENEW_WITHIN_DAYS) return 'expiring';
  return 'valid';
}

// -------------------------------------------------------------------- store

/**
 * Certificate metadata. The private key stays on the server; only public
 * metadata is persisted so the panel can reason about expiry.
 */
class CertStore {
  constructor(baseDir) {
    this.dir = baseDir;
    this.file = path.join(baseDir, 'certs.json');
    this.items = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const c of raw || []) this.items.set(c.id, c);
    } catch {
      /* first run */
    }
  }

  persist() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify([...this.items.values()], null, 2));
  }

  list() {
    return [...this.items.values()].map((c) => ({ ...c, status: statusOf(c), daysLeft: daysUntil(c.notAfter) }));
  }

  get(id) {
    return this.items.get(id) || null;
  }

  find(domain) {
    const d = normaliseDomain(domain);
    for (const c of this.items.values()) if (c.domain === d) return c;
    return null;
  }

  put(cert) {
    const record = { id: cert.id || crypto.randomUUID(), createdAt: new Date().toISOString(), ...cert };
    this.items.set(record.id, record);
    this.persist();
    return record;
  }

  remove(id) {
    const had = this.items.delete(id);
    if (had) this.persist();
    return had;
  }
}

// ------------------------------------------------------------------ issuance

/**
 * Read the certificate that is actually on the server now.
 *
 * The store is a cache, not the truth: a certificate can be replaced, expired or
 * deleted outside the panel, and the panel should describe reality.
 */
async function inspect(sshExec, server, { certPath = CERT_PATH, keyPath = KEY_PATH } = {}) {
  const script = `
set -e
if [ ! -f ${shellQuote(certPath)} ]; then echo "MISSING"; exit 0; fi
openssl x509 -in ${shellQuote(certPath)} -noout -subject -enddate -fingerprint -sha256 2>/dev/null || {
  echo "UNREADABLE"; exit 0;
}
openssl x509 -in ${shellQuote(certPath)} -noout -checkend 0 >/dev/null 2>&1 || echo "EXPIRED"
`.trim();

  const res = await sshExec(server, script, { timeout: 25000 });
  if (res.failed) return { present: false, error: res.stderr || 'ssh failed' };
  const out = res.stdout || '';
  if (/^MISSING/m.test(out)) return { present: false, reason: 'no file at ' + certPath };
  if (/^UNREADABLE/m.test(out)) return { present: false, reason: 'file is not a readable certificate' };

  const subject = (out.match(/subject=.*CN\s*=\s*([^\n,/]+)/) || [])[1];
  const notAfter = (out.match(/notAfter=([^\n]+)/) || [])[1];
  const fp = (out.match(/Fingerprint=([^\n]+)/) || [])[1];
  return {
    present: true,
    commonName: subject ? subject.trim() : null,
    notAfter: notAfter ? new Date(notAfter.trim()).toISOString() : null,
    fingerprint: fingerprint(fp),
    expired: /^EXPIRED/m.test(out),
    path: certPath,
    keyPath,
  };
}

/**
 * Issue a self-signed certificate.
 *
 * Runs entirely on the target server with openssl, so nothing about the key ever
 * touches the panel or the network between them.
 */
async function issueSelfSigned(sshExec, server, { domain, days = SELF_SIGNED_DAYS, certPath = CERT_PATH, keyPath = KEY_PATH } = {}) {
  const check = validateDomain(domain);
  if (!check.ok) return { ok: false, error: check.error };

  const script = `
set -e
install -d -m 0755 ${shellQuote(dirOf(certPath))}
umask 077
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
openssl req -x509 -nodes -newkey rsa:2048 -sha256 \\
  -days ${Number(days)} \\
  -keyout "$TMPD/key.pem" \\
  -out "$TMPD/cert.pem" \\
  -subj "/CN=${check.domain}" \\
  -addext "subjectAltName=DNS:${check.domain}" \\
  -addext "basicConstraints=critical,CA:FALSE" \\
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \\
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null
install -m 0644 "$TMPD/cert.pem" ${shellQuote(certPath)}
install -m 0600 "$TMPD/key.pem" ${shellQuote(keyPath)}
openssl x509 -in ${shellQuote(certPath)} -noout -subject -enddate -fingerprint -sha256
`.trim();

  const res = await sshExec(server, script, { timeout: 60000 });
  if (res.failed) return { ok: false, error: (res.stderr || res.stdout || 'openssl failed').trim().slice(0, 400) };

  const out = res.stdout || '';
  const subject = (out.match(/subject=.*CN\s*=\s*([^\n,/]+)/) || [])[1];
  const notAfter = (out.match(/notAfter=([^\n]+)/) || [])[1];
  const fp = (out.match(/Fingerprint=([^\n]+)/) || [])[1];

  return {
    ok: true,
    mode: 'self-signed',
    domain: check.domain,
    commonName: subject ? subject.trim() : check.domain,
    notAfter: notAfter ? new Date(notAfter.trim()).toISOString() : null,
    fingerprint: fingerprint(fp),
    certPath,
    keyPath,
  };
}

/**
 * Issue a Let's Encrypt certificate.
 *
 * Deliberately loud about prerequisites instead of failing obscurely:
 *   - the domain must already resolve to this server's public IP
 *   - port 80 must be reachable from the internet for the http-01 challenge
 *
 * Returns a structured reason rather than a raw certbot error so the UI can say
 * what to actually do about it.
 */
async function issueLetsEncrypt(sshExec, server, { domain, email = '', certPath = CERT_PATH, keyPath = KEY_PATH, serverIp = null } = {}) {
  const check = validateDomain(domain);
  if (!check.ok) return { ok: false, error: check.error };

  // 1. DNS has to point here, or the challenge can never complete.
  if (serverIp) {
    const resolved = await sshExec(
      server,
      `getent ahostsv4 ${shellQuote(check.domain)} 2>/dev/null | awk 'NR==1{print $1}'`,
      { timeout: 20000 },
    );
    const ip = (resolved.stdout || '').trim();
    if (!ip) {
      return {
        ok: false,
        reason: 'dns-unresolved',
        error: `دامنه ${check.domain} از سرور قابل resolve نیست. برای Let's Encrypt باید رکورد DNS آن به ${serverIp} اشاره کند.`,
      };
    }
    if (ip !== serverIp) {
      return {
        ok: false,
        reason: 'dns-mismatch',
        error: `دامنه ${check.domain} به ${ip} اشاره می‌کند ولی IP این سرور ${serverIp} است.`,
      };
    }
  }

  // 2. certbot has to exist; install it only when it is missing.
  const have = await sshExec(server, 'command -v certbot || true', { timeout: 15000 });
  if (!(have.stdout || '').trim()) {
    const install = await sshExec(
      server,
      'export DEBIAN_FRONTEND=noninteractive; ' +
        '(apt-get update -qq && apt-get install -y -qq certbot) 2>&1 | tail -3 || ' +
        '(yum install -y certbot 2>&1 | tail -3 || dnf install -y certbot 2>&1 | tail -3 || apk add --no-cache certbot 2>&1 | tail -3)',
      { timeout: 600000 },
    );
    const now = await sshExec(server, 'command -v certbot || true', { timeout: 15000 });
    if (!(now.stdout || '').trim()) {
      return {
        ok: false,
        reason: 'certbot-unavailable',
        error: `نصب certbot ناموفق بود: ${(install.stderr || install.stdout || '').trim().slice(0, 200)}`,
      };
    }
  }

  // 3. Standalone on port 80, because nothing else owns it in these configs.
  const args = [
    'certbot certonly --non-interactive --agree-tos',
    '--standalone',
    '--preferred-challenges http',
    `-d ${shellQuote(check.domain)}`,
    email ? `--email ${shellQuote(email)}` : '--register-unsafely-without-email',
    '--keep-until-expiring',
  ].join(' ');

  const res = await sshExec(server, args, { timeout: 420000 });
  if (res.failed) {
    const raw = `${res.stdout || ''}\n${res.stderr || ''}`;
    let reason = 'letsencrypt-failed';
    let error = raw.trim().slice(-500);
    if (/Timeout|timeout during connect|connection refused/i.test(raw)) {
      reason = 'challenge-unreachable';
      error =
        'چالش http-01 از اینترنت به پورت ۸۰ این سرور نرسید. مطمئن شوید پورت ۸۰ در فایروال باز است و هیچ سرویسی روی آن گوش نمی‌دهد.';
    } else if (/already exists|too many certificates|rate limit/i.test(raw)) {
      reason = 'rate-limited';
      error = raw.trim().slice(-300);
    } else if (/NXDOMAIN|Invalid response|urn:ietf:params:acme:error/i.test(raw)) {
      reason = 'dns-mismatch';
      error = 'مرجع CA نتوانست دامنه را تأیید کند. رکورد DNS و دسترسی پورت ۸۰ را بررسی کنید.';
    }
    return { ok: false, reason, error };
  }

  // 4. Copy into the managed location so templates always find it.
  const install = await sshExec(
    server,
    `set -e
     install -d -m 0755 ${shellQuote(dirOf(certPath))}
     install -m 0644 /etc/letsencrypt/live/${shellQuote(check.domain)}/fullchain.pem ${shellQuote(certPath)}
     install -m 0600 /etc/letsencrypt/live/${shellQuote(check.domain)}/privkey.pem   ${shellQuote(keyPath)}
     openssl x509 -in ${shellQuote(certPath)} -noout -subject -enddate -fingerprint -sha256`,
    { timeout: 60000 },
  );
  if (install.failed) {
    return { ok: false, reason: 'install-failed', error: (install.stderr || '').trim().slice(0, 300) };
  }

  const out = install.stdout || '';
  const subject = (out.match(/subject=.*CN\s*=\s*([^\n,/]+)/) || [])[1];
  const notAfter = (out.match(/notAfter=([^\n]+)/) || [])[1];
  const fp = (out.match(/Fingerprint=([^\n]+)/) || [])[1];
  const issuer = (out.match(/issuer=.*CN\s*=\s*([^\n,/]+)/) || [])[1];

  return {
    ok: true,
    mode: 'letsencrypt',
    domain: check.domain,
    commonName: subject ? subject.trim() : check.domain,
    issuer: issuer ? issuer.trim() : null,
    notAfter: notAfter ? new Date(notAfter.trim()).toISOString() : null,
    fingerprint: fingerprint(fp),
    certPath,
    keyPath,
  };
}

/**
 * Make sure a usable certificate for `domain` exists on this server, issuing or
 * renewing only when needed. This is what "automatic" means in practice: apply
 * a tunnel with a domain and the certificate is handled for you.
 */
async function ensure(
  sshExec,
  server,
  { domain, mode = 'auto', email = '', serverIp = null, force = false, certPath, keyPath } = {},
) {
  const check = validateDomain(domain);
  if (!check.ok) return { ok: false, skipped: true, error: check.error };

  // A template that reads its certificate from a per-tunnel path must have the
  // certificate written there. Anything else starts the service against a file
  // that does not exist.
  const paths = {};
  if (certPath) paths.certPath = certPath;
  if (keyPath) paths.keyPath = keyPath;

  const current = await inspect(sshExec, server, paths);
  const daysLeft = daysUntil(current.notAfter);

  if (!force && current.present && !current.expired) {
    const matchesDomain = current.commonName === check.domain;
    if (matchesDomain && daysLeft !== null && daysLeft > RENEW_WITHIN_DAYS) {
      return { ok: true, reused: true, ...current, mode: current.issuer ? 'letsencrypt' : 'self-signed' };
    }
  }

  // "auto" prefers a real certificate and falls back rather than failing.
  if (mode === 'auto' || mode === 'letsencrypt') {
    const le = await issueLetsEncrypt(sshExec, server, { domain: check.domain, email, serverIp, ...paths });
    if (le.ok) return le;
    if (mode === 'letsencrypt') return le;
    return {
      ...(await issueSelfSigned(sshExec, server, { domain: check.domain, ...paths })),
      fallbackFrom: le.reason,
      fallbackNote: le.error,
    };
  }

  return issueSelfSigned(sshExec, server, { domain: check.domain, ...paths });
}

module.exports = {
  CERT_DIR,
  CERT_PATH,
  KEY_PATH,
  RENEW_WITHIN_DAYS,
  SELF_SIGNED_DAYS,
  CertStore,
  normaliseDomain,
  validateDomain,
  daysUntil,
  statusOf,
  inspect,
  issueSelfSigned,
  issueLetsEncrypt,
  ensure,
};