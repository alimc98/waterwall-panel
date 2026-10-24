'use strict';

/* WaterWall Panel — front end (vanilla, no build step) */

const state = {
  token: localStorage.getItem('ww_token') || '',
  servers: [],
  tunnels: [],
  templates: [],
  versions: null,
  certs: null,
  outbound: null,
  outboundLog: '',
  links: null,        // CDN link checks, null until the first probe returns
  linksBusy: false,
  linksError: null,
  linksCheckedAt: null,
  linksProbed: false,
  certsPageToken: 0,
  lastCertPage: -1,
  lastRenderedPage: null,
  page: 'dashboard',
  selectedTemplate: null,
  draft: null,        // working copy of the tunnel form
  preview: null,      // last preview result
  currentTunnel: null,
  currentServer: null,
  activePreviewTab: 'iran',
  upgrade: null,      // upstream releases + the per-server upgrade plan
  upgradeBusy: false,
  upgradeMsg: null,   // the outcome of the last upgrade run
};

// ------------------------------------------------------------------ utils
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Escape a value for HTML.
 *
 * The single quote is escaped too, even though the UI currently only puts these
 * values in double-quoted attributes and text nodes. Escaping it costs nothing
 * and removes a whole class of mistake: one template field placed inside
 * `data-when='…'` was already relying on a quote that this function did not
 * escape, and that is exactly the shape an attribute-breakout needs.
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'authorization': `Bearer ${state.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`پاسخ نامعتبر از سرور (HTTP ${res.status})`);
  }
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.problems = json.problems;
    throw err;
  }
  return json;
}

async function copy(text, label = 'متن') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} کپی شد`, 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`${label} کپی شد`, 'ok');
  }
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function bytes(n) {
  if (!n && n !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Colourised JSON, with RTL-safe rendering. */
function highlight(json) {
  const text = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
  return esc(text).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'n';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'k' : 's';
      else if (/true|false|null/.test(match)) cls = 'b';
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

function openModal(title, bodyHtml, buttons = []) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalFoot').innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = b.class || '';
    btn.textContent = b.text;
    btn.onclick = () => b.onClick?.(btn);
    $('#modalFoot').appendChild(btn);
  }
  $('#modal').classList.add('open');
}

function closeModal() {
  $('#modal').classList.remove('open');
}

$('#modal').onclick = (e) => {
  if (e.target.id === 'modal') closeModal();
};

// ------------------------------------------------------------------ login
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const token = $('#loginToken').value.trim();
  if (!token) return;
  state.token = token;
  try {
    await loadAll();
    localStorage.setItem('ww_token', token);
    $('#login').style.display = 'none';
    $('#app').classList.add('ready');
    connectEvents();
    render();
  } catch (err) {
    const box = $('#loginError');
    box.textContent = err.message;
    box.style.display = 'block';
  }
};

$('#logoutBtn').onclick = () => {
  localStorage.removeItem('ww_token');
  location.reload();
};

async function loadAll() {
  const data = await api('/api/bootstrap');
  state.servers = data.servers;
  state.tunnels = data.tunnels;
  state.templates = data.templates;
  state.versions = data.versions || null;
  state.outbound = data.outbound || null;
}

/**
 * The upstream releases, for the upgrade card.
 *
 * Fetched on its own rather than as part of bootstrap: the release list comes
 * from GitHub and must not delay the panel itself from opening.
 */
async function loadUpgradeReleases() {
  try {
    const r = await api('/api/upgrade/releases');
    state.upgrade = { ...(state.upgrade || {}), releases: r.releases || [] };
  } catch (err) {
    // A GitHub outage must not break the servers page; the upgrade card
    // shows the error and the operator can retry.
    state.upgrade = { ...(state.upgrade || {}), releases: [], error: err.message };
  }
}

/** Certificate state is fetched separately; it is not part of bootstrap. */
async function loadCerts() {
  try {
    state.certs = await api('/api/certs');
  } catch (err) {
    state.certs = null;
  }
}

// ------------------------------------------------------------ live events
let eventSource = null;
function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
  eventSource.addEventListener('open', () => setConn(true));
  eventSource.addEventListener('error', () => setConn(false));
  for (const evt of ['servers', 'tunnels', 'log', 'server-status', 'outbound']) {
    eventSource.addEventListener(evt, async (e) => {
      try {
        const data = JSON.parse(e.data);
        if (evt === 'servers' && Array.isArray(data)) state.servers = data;
        if (evt === 'tunnels' && Array.isArray(data)) {
          state.tunnels = data;
          if (state.page === 'dashboard' || state.page === 'tunnels') render();
        }
        if (evt === 'outbound' && data && typeof data === 'object') {
          state.outbound = data;
          if (state.page === 'outbound') render();
        }
        if (evt === 'server-status') {
          const s = state.servers.find((x) => x.id === data.serverId);
          if (s) {
            s.lastSeen = new Date().toISOString();
            s.lastStatus = data.status;
            if (state.page === 'servers') render();
          }
        }
      } catch {
        /* ignore malformed events */
      }
    });
  }
}

function setConn(on) {
  $('#sseDot').classList.toggle('on', on);
  $('#sseText').textContent = on ? 'آنلاین' : 'قطع';
}

// -------------------------------------------------------------- navigation
$$('.nav-item[data-page]').forEach((el) => {
  el.onclick = () => {
    $$('.nav-item[data-page]').forEach((n) => n.classList.remove('active'));
    el.classList.add('active');
    state.page = el.dataset.page;
    render();
  };
});

function go(page) {
  const nav = $(`.nav-item[data-page="${page}"]`);
  if (nav) {
    nav.click();
    return;
  }
  // `edit` has no nav entry of its own — it belongs under "tunnels".
  $$('.nav-item[data-page]').forEach((n) => n.classList.toggle('active', n.dataset.page === 'tunnels'));
  state.page = page;
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  const el = $('#content');
  // A page change is the trigger for one-shot page setup. Bumping here rather
  // than in one navigation helper covers every way into the page.
  if (state.lastRenderedPage !== state.page) {
    state.lastRenderedPage = state.page;
    state.certsPageToken += 1;
    // A CDN link is only worth probing when its card is on screen. Leaving the
    // dashboard clears the flag so coming back re-checks instead of showing a
    // stale verdict from an hour ago.
    if (state.page !== 'dashboard') state.linksProbed = false;
    // The upgrade card needs the upstream release list, which comes from
    // GitHub. It is fetched when the servers page opens, not before, so a
    // slow or unreachable GitHub does not hold up the panel.
    if (state.page === 'servers' && !state.upgrade?.releases?.length) {
      loadUpgradeReleases().then(() => {
        if (state.page === 'servers') render();
      });
    }
  }
  const fns = {
    dashboard: pageDashboard,
    servers: pageServers,
    outbound: pageOutbound,
    tunnels: pageTunnels,
    new: pageNewTunnel,
    edit: pageEditTunnel,
    test: pageTest,
    api: pageApi,
    backup: pageBackup,
    certs: pageCerts,
  };
  el.innerHTML = (fns[state.page] || pageDashboard)();
  afterRender();
}

// =============================================================== dashboard
/**
 * The panel's own way out, at a glance.
 *
 * This is the first thing to look at when "nothing deploys": if the panel is
 * going direct and the Iran box has lost its international route, every SSH and
 * SCP behind it fails, and the tunnel list looks fine while nothing moves.
 */
function dashOutboundCard() {
  const o = state.outbound || {};
  const running = Boolean(o.running);
  const binary = o.binary || '';
  const port = Number(o.port) || 1081;
  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3 style="margin:0">🌐 مسیر خروجی پنل</h3>
        <span class="badge ${running ? 'ok' : 'mute'}">${running ? 'از پروکسی' : 'مستقیم'}</span>
      </div>
      <div class="chain mt">
        ${
          running
            ? `SSH/SCP پنل <span class="muted">→</span> <span class="mono ltr">127.0.0.1:${port}</span> <span class="muted">→</span> Xray`
            : `SSH/SCP پنل <span class="muted">→</span> اینترنت مستقیم سرور ایران`
        }
      </div>
      <p class="small muted" style="line-height:2;margin-top:12px">
        ${
          running
            ? 'همهٔ اتصال‌های پنل به سرورها از این پروکسی می‌گذرد؛ اگر اینترنت بین‌الملل سرور ایران قطع شود، اعمال کانفیگ از همین مسیر انجام می‌شود.'
            : 'پنل مستقیم به سرورها وصل می‌شود. اگر اینترنت سرور ایران قطع شد، از این‌جا یک کانفیگ Xray بدهید تا SSHها از آن مسیر بروند.'
        }
      </p>
      <div class="small" style="line-height:2">
        <div>باینری Xray: ${binary ? `<span class="mono ltr">${esc(binary)}</span> <span class="badge ${o.binaryPresent ? 'ok' : 'err'}">${o.binaryPresent ? 'هست' : 'پیدا نشد'}</span>` : '<span class="muted">تنظیم نشده</span>'}</div>
        ${running && o.since ? `<div class="muted">فعال از ${esc(fmtDate(o.since))}</div>` : ''}
      </div>
      ${o.lastError ? `<div class="err-box mt">${esc(o.lastError)}</div>` : ''}
      <div class="row mt"><button id="dashOutbound">مدیریت مسیر</button></div>
    </div>`;
}

/**
 * The CDN links, each with a real verdict from a request through the CDN.
 *
 * "Uploaded" is not "working": the exit dials the CDN and the CDN dials the
 * origin, and that second hop is the one that quietly breaks. The badge here is
 * the answer from that hop, not a guess from the stored config.
 */
function dashCdnCard() {
  const rows = state.links;
  let body;
  if (state.linksError) {
    body = `<div class="err-box">${esc(state.linksError)}</div>`;
  } else if (state.linksBusy && !rows) {
    body = '<div class="small muted" style="padding:14px 0">در حال بررسی لینک‌ها…</div>';
  } else if (!rows || !rows.length) {
    body = `<div class="empty" style="padding:14px">
      <span class="small muted">تونلی پشت CDN ثبت نشده است.</span>
    </div>`;
  } else {
    body = `<table class="mt"><thead><tr><th>لینک</th><th>آدرس</th><th>وضعیت</th></tr></thead><tbody>
      ${rows
        .map(
          (l) => `<tr>
            <td><strong>${esc(l.name)}</strong><div class="small muted ltr">${l.kind === 'ws' ? 'WebSocket' : 'split'}</div></td>
            <td class="ltr small">${esc(l.host || '—')}${l.host ? `:${l.port}` : ''}<div class="small muted">${esc(l.path)}</div></td>
            <td>
              <span class="badge ${esc(l.cls || 'mute')}">${esc(l.label || '?')}</span>
              ${l.httpStatus ? `<div class="small muted ltr">HTTP ${l.httpStatus}${l.ms != null ? ` · ${l.ms}ms` : ''}</div>` : ''}
              <div class="small muted">${esc(l.detail || '')}</div>
            </td>
          </tr>`,
        )
        .join('')}
    </tbody></table>`;
  }
  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3 style="margin:0">☁️ لینک‌های CDN</h3>
        <button class="sm" id="dashLinksCheck" ${state.linksBusy ? 'disabled' : ''}>🔄 بررسی</button>
      </div>
      ${body}
      <p class="small muted" style="line-height:2;margin-top:12px">
        بررسی از خود سرور ایران انجام می‌شود: پنل <span class="muted">→</span> لبهٔ CDN <span class="muted">→</span> origin.
        برای تونل WebSocket فقط <span class="mono">101</span> سالم است؛ پاسخ <span class="mono">502/520</span> یعنی CDN به origin نمی‌رسد.
        ${state.linksCheckedAt && !state.linksBusy ? `<br>آخرین بررسی: ${esc(fmtDate(state.linksCheckedAt))}` : ''}
      </p>
    </div>`;
}

function pageDashboard() {
  const online = state.servers.filter((s) => s.lastStatus && Date.now() - new Date(s.lastSeen).getTime() < 90000);
  const iran = state.servers.find((s) => s.role === 'iran');
  const foreign = state.servers.find((s) => s.role === 'foreign');

  return `
  <div class="page-head">
    <h2>داشبورد</h2>
    <span class="desc">وضعیت کلی سرورها و تونل‌ها</span>
    <div class="spacer"></div>
    <button class="primary" id="quickNew">➕ تونل جدید</button>
  </div>

  <div class="grid c4 mb">
    <div class="stat"><div class="k">سرورهای ثبت‌شده</div><div class="v">${state.servers.length}</div><div class="s">${online.length} آنلاین</div></div>
    <div class="stat"><div class="k">تانل‌ها</div><div class="v">${state.tunnels.length}</div><div class="s">${state.tunnels.filter((t) => t.enabled).length} فعال</div></div>
    <div class="stat"><div class="k">سناریوها</div><div class="v">${state.templates.length}</div><div class="s">قالب آماده</div></div>
    <div class="stat"><div class="k">سرویس واتروال</div><div class="v" style="font-size:16px">${
      online.length ? '🟢 فعال' : state.servers.length ? '⚪️ نامشخص' : '—'
    }</div><div class="s">گزارش ایجنت</div></div>
  </div>

  <div class="grid c2 mb">
    ${dashOutboundCard()}
    ${dashCdnCard()}
  </div>

  <div class="grid c2">
    <div class="card">
      <h3>🔗 مسیر تونل</h3>
      <div class="chain">
        ${iran?.host || 'سرور ایران ثبت نشده'} <span class="muted">⟷</span> ${foreign?.host || 'سرور خارج ثبت نشده'}
      </div>
      <p class="small muted mt">پنل هر دو سرور را از طریق ایجنت مدیریت می‌کند. هر تغییری در تونل‌ها به‌صورت خودکار روی هر دو سرور اعمال می‌شود.</p>
      ${
        !iran || !foreign
          ? '<div class="warn-box mt">هنوز هر دو سرور (ایران و خارج) ثبت نشده‌اند. از بخش «سرورها» آن‌ها را اضافه کنید.</div>'
          : ''
      }
      <div class="row mt">
        <button id="dashServers">مدیریت سرورها</button>
        <button id="dashTunnels">مشاهده تونل‌ها</button>
      </div>
    </div>

    <div class="card">
      <h3>🕒 آخرین رویدادها</h3>
      <div class="logbox" id="dashLog" style="max-height:280px">در حال بارگذاری…</div>
    </div>
  </div>

  <div class="card">
    <h3>📚 مستندات سناریوها</h3>
    <p class="small muted">هر قالب در پنل دقیقاً با همان زنجیره‌ای ساخته می‌شود که در مستندات رسمی واتروال توضیح داده شده است.</p>
    <div class="row mt">
      <a class="btn" href="https://radkesvat.github.io/WaterWall-Docs/docs/noderefs/all-nodes" target="_blank">مرجع نودها</a>
      <a class="btn" href="https://radkesvat.github.io/WaterWall-Docs/docs/getting-started/tutorial-part4" target="_blank">انتخاب نود</a>
      <a class="btn" href="https://radkesvat.github.io/WaterWall-Docs/docs/getting-started/installation" target="_blank">نصب</a>
    </div>
  </div>`;
}

/**
 * What release the panel targets, what that release changed, and which
 * settings WaterWall has removed. Shown on the servers page because a version
 * mismatch is the first thing to check when a service refuses to start.
 */
function versionCardHtml() {
  const v = state.versions;
  if (!v) return '';
  const rel = v.release;
  return `
  <div class="card">
    <h3>ℹ️ نسخه واتروال <span class="badge ${v.current ? 'ok' : ''}">${esc(v.current)}</span></h3>
    <p class="small muted" style="line-height:2">
      پنل کانفیگ‌ها را برای این نسخه می‌سازد. کمترین نسخه پشتیبانی‌شده: <span class="mono">${esc(v.oldestSupported)}</span>.
      هر تنظیمی که واتروال حذف کرده باشد <b>خطای اجرا</b> است، نه هشدار — پس پنل قبل از استقرار آن‌ها را می‌گیرد.
    </p>
    ${
      rel
        ? `<div style="margin:12px 0">
            <div style="font-weight:600;margin-bottom:6px">${esc(rel.headline)}</div>
            <ul class="small muted" style="line-height:2;padding-inline-start:20px">
              ${(rel.highlights || []).map((h) => `<li>${esc(h)}</li>`).join('')}
            </ul>
          </div>
          <details>
            <summary class="small" style="cursor:pointer;color:var(--warn)">تغییرات شکننده (${(rel.breaking || []).length} مورد)</summary>
            <ul class="small muted" style="line-height:2;padding-inline-start:20px">
              ${(rel.breaking || []).map((h) => `<li>${esc(h)}</li>`).join('')}
            </ul>
          </details>`
        : ''
    }
    ${
      (v.breaking || []).length
        ? `<details style="margin-top:10px">
            <summary class="small" style="cursor:pointer">تنظیماتی که پنل رد می‌کند (${v.breaking.length} مورد)</summary>
            <table style="margin-top:8px"><thead><tr><th>تنظیم</th><th>نود</th><th>از نسخه</th></tr></thead><tbody>
              ${v.breaking.map((b) => `<tr><td class="ltr"><b>${esc(b.key)}</b></td><td class="ltr small">${esc((b.nodes || []).join(', '))}</td><td class="ltr small">${esc(b.since)}</td></tr>`).join('')}
            </tbody></table>
          </details>`
        : ''
    }
  </div>`;
}

/**
 * The core-upgrade card.
 *
 * The panel knows which WaterWall release it is written against, and every
 * server reports the release it runs. This card is where the two are
 * compared: it lists the upstream releases, shows what each server is on,
 * and lets the operator upgrade the whole fleet in one go.
 *
 * The upgrade is deliberately two-step. The plan is shown first — which
 * build each host needs, which services would restart — because an upgrade
 * that restarts a service is not something to do blind, and because a host
 * with an old CPU needs a different build than the rest of the fleet.
 */
function upgradeCardHtml() {
  const u = state.upgrade;
  const busy = state.upgradeBusy;
  const releases = u?.releases || [];
  const rows = u?.plan?.servers || [];

  return `
  <div class="card" id="upgradeCard">
    <h3>⬆️ به‌روزرسانی هستهٔ واتروال
      <span class="badge ${u?.plan?.target === state.versions?.current ? 'ok' : ''}">${esc(u?.plan?.target || state.versions?.current || '—')}</span>
    </h3>
    <p class="small muted" style="line-height:2">
      پنل می‌تواند هستهٔ واتروال را روی سرور اصلی و روی سرورهای خارجی به‌روز کند.
      بیلد متناسب با CPU هر سرور خودکار انتخاب می‌شود (سرور بدون <span class="mono">avx2</span> بیلد <span class="mono">old-cpu</span> می‌گیرد)،
      نسخهٔ قبلی کنار باینری جدید نگه داشته می‌شود و همهٔ سرویس‌های آن سرور با هم ری‌استارت می‌شوند.
      <br>
      <b>دو سر یک تونل باید با هم ارتقا بروند</b>؛ پنل اگر ارتقا باعث شود یک تونل نصفه‌به‌نیمه بماند، اجازهٔ اجرا نمی‌دهد.
    </p>

    <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
      <select id="upgradeVersion" class="input" style="max-width:220px">
        ${releases.length
          ? releases
              .map(
                (r) =>
                  `<option value="${esc(r.version)}" ${r.version === (u?.plan?.target || state.versions?.current) ? 'selected' : ''}>${esc(r.version)}${r.version === state.versions?.current ? ' (نسخهٔ پنل)' : ''}</option>`,
              )
              .join('')
          : '<option>در حال خواندن…</option>'}
      </select>
      <button class="btn" id="upgradePlanBtn" ${busy ? 'disabled' : ''}>🔍 بررسی برنامهٔ ارتقا</button>
      <button class="primary" id="upgradeApplyBtn" ${busy || !rows.length ? 'disabled' : ''}>
        ${busy ? 'در حال انجام…' : '⬆️ ارتقای همهٔ سرورها'}
      </button>
      ${u?.plan?.split?.length ? '<button class="btn danger" id="upgradePartialBtn">فقط سرورهای انتخابی</button>' : ''}
    </div>

    ${state.upgradeMsg ? `<div class="${state.upgradeMsg.ok ? 'ok-box' : 'err-box'}" style="margin-top:12px">${state.upgradeMsg.text}</div>` : ''}

    ${
      rows.length
        ? `<table style="margin-top:12px"><thead><tr>
            <th>سرور</th><th>نسخهٔ فعلی</th><th>معماری</th><th>بیلد لازم</th><th>سرویس‌ها</th><th></th>
          </tr></thead><tbody>
          ${rows
            .map((r) => {
              if (!r.ok) {
                return `<tr><td><strong>${esc(r.name)}</strong></td><td colspan="5" class="small" style="color:var(--err)">${esc(r.error || 'در دسترس نیست')}</td><td></td></tr>`;
              }
              const stale = r.outdated ? 'err' : 'ok';
              return `<tr>
                <td><strong>${esc(r.name)}</strong><br><span class="small muted ltr">${esc(r.host || '')}</span></td>
                <td><span class="badge ${r.reported ? stale : 'mute'}">${r.reported ? esc(r.reported) : 'نامشخص'}</span></td>
                <td class="ltr small">${esc(r.arch || '—')}${r.hasAvx2 === false ? ' <span class="badge mute">بدون avx2</span>' : ''}</td>
                <td class="ltr small">${esc(r.asset || '—')}<br><span class="small muted">${esc(r.assetReason || '')}</span></td>
                <td class="ltr small">${(r.units || []).map((u) => esc(u)).join('<br>') || '—'}</td>
                <td style="white-space:nowrap">
                  ${
                    r.nothingToDo
                      ? '<span class="small muted">نصبی ندارد</span>'
                      : `<button class="sm" data-upgrade-one="${esc(r.id)}">ارتقای این سرور</button>`
                  }
                </td>
              </tr>`;
            })
            .join('')}
          </tbody></table>`
        : ''
    }

    ${
      releases.length
        ? `<details style="margin-top:12px">
            <summary class="small" style="cursor:pointer">یادداشت انتشار ${esc(u?.plan?.target || '')}</summary>
            <pre class="code" style="direction:ltr;text-align:left;margin-top:8px;max-height:320px;overflow:auto">${esc(
              releases.find((r) => r.version === (u?.plan?.target || state.versions?.current))?.notes || '',
            )}</pre>
          </details>`
        : ''
    }
  </div>`;
}

// ================================================================= certificates
/**
 * Certificate page.
 *
 * The point of this screen is that a certificate can silently be wrong for a
 * long time, so it shows each server's live state (read from the box now, not
 * from the panel's cache), the managed location, and a form to issue one.
 */
function pageCerts() {
  if (!state.certs) {
    return '<div class="page-head"><h2>گواهی‌ها</h2></div><div class="card"><div class="empty">در حال خواندن…</div></div>';
  }

  const BADGE = {
    valid: ['معتبر', 'ok'],
    expiring: ['نزدیک انقضا', 'err'],
    expired: ['منقضی', 'err'],
    missing: ['ندارد', ''],
    unknown: ['نامشخص', ''],
  };

  const servers = (state.certs.servers || [])
    .map((row) => {
      const live = row.live || {};
      const key = !live.present ? 'missing' : live.status || 'unknown';
      const [text, cls] = BADGE[key] || ['?', ''];
      const days = live.daysLeft;
      return `<tr>
        <td><strong>${esc(row.server.name)}</strong><br><span class="badge">${esc(row.server.role)}</span></td>
        <td class="ltr small">${esc(row.server.host)}</td>
        <td class="ltr"><span class="badge ${cls}">${esc(text)}</span>${days !== null && days !== undefined ? `<div class="small muted ltr">${days} روز</div>` : ''}</td>
        <td class="ltr small">${esc(live.commonName || live.reason || '—')}</td>
        <td class="ltr small">${esc(live.notAfter ? fmtDate(live.notAfter) : '—')}</td>
        <td class="ltr small" style="max-width:220px;overflow:hidden;text-overflow:ellipsis" title="${esc(live.fingerprint || '')}">${esc(live.fingerprint || '—')}</td>
      </tr>`;
    })
    .join('');

  return `
  <div class="page-head">
    <h2>گواهی‌ها</h2>
    <span class="desc">ساخت خودکار گواهی TLS برای تونل‌ها</span>
    <div class="spacer"></div>
    <button class="primary" id="certIssue">➕ صدور گواهی</button>
  </div>

  <div class="card">
    <h3>وضعیت روی سرورها</h3>
    <p class="small muted" style="line-height:2">
      گواهی‌ها در ${esc(state.certs.certPath)} نصب می‌شوند. وقتی در تونل فیلد «دامنه» را پر کنید،
      پنل هنگام اعمال خودکار گواهی را می‌سازد یا تمدید می‌کند.
    </p>
    <table><thead><tr>
      <th>سرور</th><th>آدرس</th><th>وضعیت</th><th>دامنه (CN)</th><th>انقضا</th><th>اثر انگشت</th>
    </tr></thead><tbody>${servers || '<tr><td colspan="6" class="empty">سروری ثبت نشده است.</td></tr>'}</tbody></table>
  </div>

  <div class="card">
    <h3>صدور گواهی جدید</h3>
    <p class="small muted" style="line-height:2">
      این فرم مستقل از تونل است. برای اینکه هر تونل خودکار گواهی بگیرد، در همان تونل
      فیلد «دامنه» را پر کنید.
    </p>
    <div class="row">
      <label class="f" style="flex:1;min-width:220px;margin:0">
        <span class="lbl">دامنه</span>
        <input type="text" id="certDomain" placeholder="example.com">
      </label>
      <label class="f" style="width:180px;margin:0">
        <span class="lbl">روش</span>
        <select id="certMode">
          <option value="auto">خودکار (CA یا خودامضا)</option>
          <option value="letsencrypt">فقط Let's Encrypt</option>
          <option value="self-signed">فقط خودامضا</option>
        </select>
      </label>
      <label class="f" style="width:180px;margin:0">
        <span class="lbl">سرور</span>
        <select id="certServer"></select>
      </label>
      <label class="f" style="width:180px;margin:0">
        <span class="lbl">ایمیل (اختیاری)</span>
        <input type="text" id="certEmail" placeholder="you@example.com">
      </label>
      <button class="primary" id="certIssueNow" style="margin-top:22px">صدور</button>
    </div>
    <div id="certOut" class="mt"></div>
    <div style="margin-top:14px">
      <details>
        <summary class="small" style="cursor:pointer">پیش‌نیازهای Let's Encrypt</summary>
        <ul class="small muted" style="line-height:2.1;padding-inline-start:20px">
          <li>رکورد A دامنه باید به IP عمومی همان سرور اشاره کند</li>
          <li>پورت ۸۰ روی آن سرور باید از اینترنت باز باشد (چالش http-01)</li>
          <li>هیچ سرویس دیگری نباید روی پورت ۸۰ گوش بدهد</li>
          <li>اگر این شرط‌ها برقرار نباشد، حالت «خودکار» بی‌سروصدا گواهی خودامضا می‌سازد</li>
        </ul>
      </details>
    </div>
  </div>`;
}

// ================================================================= backup
/**
 * Export/import the panel's own state.
 *
 * The download has to be a blob: the endpoint is behind the API token, so a
 * plain link cannot carry the Authorization header. The file is generated by
 * the server, not assembled here, so what is backed up is exactly what the
 * panel stores.
 */
function pageBackup() {
  return `
  <div class="page-head">
    <h2>پشتیبان‌گیری</h2>
    <span class="desc">تنظیمات پنل را بگیرید و روی نصب تازه برگردانید</span>
  </div>

  <div class="grid c2">
    <div class="card">
      <h3>📤 گرفتن پشتیبان</h3>
      <p class="small muted" style="line-height:2">
        فایل JSON شامل سرورها (آدرس، پورت، مسیر و توکن ایجنت)، تانل‌ها و تنظیمات مسیر خروجی پنل است.
        کلیدهای SSH داخل فایل نیستند و باید جداگانه روی نصب تازه کپی شوند؛ توکن خود پنل هم در پشتیبان نیست.
        این فایل حساس است، جای امن نگهش دارید.
      </p>
      <button class="primary" id="backupDownload">⬇️ دانلود پشتیبان</button>
    </div>

    <div class="card">
      <h3>📥 برگرداندن پشتیبان</h3>
      <p class="small muted">فایل پشتیبان را انتخاب کنید؛ فهرست سرورها و تانل‌های فعلی با محتوای آن جایگزین می‌شود.</p>
      <input type="file" id="backupFile" accept="application/json,.json">
      <div class="row mt"><button id="backupRestore">بازیابی</button></div>
      <div id="backupResult" class="mt"></div>
    </div>
  </div>`;
}

function wireBackup() {
  const download = document.getElementById('backupDownload');
  if (download) {
    download.onclick = async () => {
      try {
        const res = await fetch('/api/backup', { headers: { authorization: `Bearer ${state.token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `waterwall-backup-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        toast('پشتیبان دانلود شد', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }

  const restore = document.getElementById('backupRestore');
  if (restore) {
    restore.onclick = async () => {
      const file = document.getElementById('backupFile')?.files?.[0];
      if (!file) {
        toast('اول فایل پشتیبان را انتخاب کنید', 'err');
        return;
      }
      if (!confirm('سرورها و تانل‌های فعلی با محتوای این پشتیبان جایگزین شوند؟')) return;
      const box = document.getElementById('backupResult');
      try {
        const data = JSON.parse(await file.text());
        const r = await api('/api/restore', { method: 'POST', body: data });
        state.servers = (await api('/api/bootstrap')).servers;
        box.innerHTML = `<div class="ok-box">${r.servers} سرور و ${r.tunnels} تانل بازیابی شد. برای دیدن فهرست، صفحه را عوض کنید.</div>`;
        toast('بازیابی انجام شد', 'ok');
      } catch (err) {
        box.innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
      }
    };
  }
}

// ================================================================ outbound
/**
 * "Internet for the panel": a local Xray client whose SOCKS port every SSH the
 * panel makes is routed through. It exists for the case where the Iran box loses
 * its direct international route and still has to push configs to the foreign
 * servers.
 */
function outboundBody() {
  return {
    config: document.getElementById('obConfig').value,
    port: Number(document.getElementById('obPort').value) || 1081,
    binary: document.getElementById('obBinary').value.trim(),
  };
}

function pageOutbound() {
  const o = state.outbound || {};
  const running = Boolean(o.running);
  const binary = o.binary || '';
  return `
  <div class="page-head">
    <h2>اینترنت پنل</h2>
    <span class="desc">مسیر خروجی پنل برای وقتی که سرور ایران به اینترنت بین‌الملل دسترسی ندارد</span>
    <div class="spacer"></div>
    <span class="badge ${running ? 'ok' : 'mute'}">${running ? 'فعال' : 'خاموش'}</span>
  </div>

  <div class="grid c3 mb">
    <div class="stat">
      <div class="k">پروکسی محلی</div>
      <div class="v ltr" style="font-size:16px">${running ? esc('127.0.0.1:' + o.port) : '—'}</div>
      <div class="s">${running ? 'همهٔ SSH/SCP پنل از این مسیر می‌رود' : 'اتصال‌ها از مسیر مستقیم می‌روند'}</div>
    </div>
    <div class="stat">
      <div class="k">باینری Xray</div>
      <div class="v ltr" style="font-size:12px;word-break:break-all">${binary ? esc(binary) : '—'}</div>
      <div class="s">${binary ? (o.binaryPresent ? '✅ روی این سیستم هست' : '⛔️ پیدا نشد') : 'مسیر را وارد کنید'}</div>
    </div>
    <div class="stat">
      <div class="k">فعال از</div>
      <div class="v" style="font-size:15px">${running ? esc(fmtDate(o.since)) : '—'}</div>
      <div class="s">آخرین ذخیرهٔ تنظیمات: ${o.updatedAt ? esc(fmtDate(o.updatedAt)) : '—'}</div>
    </div>
  </div>

  <div class="card mb">
    <h3>🔌 کانفیگ خروجی (Xray)</h3>
    <p class="small muted" style="line-height:2">
      همان کانفیگی را که در کلاینت خودتان کار می‌کند اینجا بگذارید؛ پنل خودش یک اینباند
      <span class="mono">socks</span> روی <span class="mono">127.0.0.1</span> به آن اضافه می‌کند، پس لازم نیست دستی بسازید.
      وقتی فعال باشد، پنل برای اعمال کانفیگ روی سرورهای خارج از همین مسیر استفاده می‌کند — یعنی حتی اگر
      اینترنت بین‌الملل سرور ایران قطع شود، فقط کافی است مسیر این پروکسی کار کند.
    </p>
    <label class="f">
      <span class="lbl">کانفیگ Xray (JSON)</span>
      <textarea id="obConfig" class="mono" spellcheck="false" placeholder='{ "outbounds": [ … ] }'
        style="min-height:240px;direction:ltr;text-align:left;font-size:12px">${esc(o.config || '')}</textarea>
    </label>
    <div class="grid c2">
      <label class="f"><span class="lbl">پورت SOCKS محلی</span><input type="number" id="obPort" min="1" max="65535" value="${Number(o.port) || 1081}"></label>
      <label class="f"><span class="lbl">مسیر باینری Xray</span><input type="text" id="obBinary" class="mono" dir="ltr" value="${esc(binary)}" placeholder="/usr/local/x-ui/bin/xray-linux-amd64"></label>
    </div>
    <div class="row mt">
      <button id="obSave">💾 ذخیره</button>
      <button class="primary" id="obStart" ${running ? 'disabled' : ''}>▶️ فعال‌سازی</button>
      <button id="obStop" ${running ? '' : 'disabled'}>⏹ توقف</button>
      <button id="obTest" ${running ? '' : 'disabled'}>🧪 تست مسیر</button>
      <button id="obLogs">🔄 لاگ Xray</button>
    </div>
    ${o.lastError ? `<div class="err-box mt">${esc(o.lastError)}</div>` : ''}
    <pre class="code mt" id="obLog" style="direction:ltr;text-align:left;max-height:280px;overflow:auto;font-size:12px">${esc(state.outboundLog || '')}</pre>
  </div>`;
}

/** Reload status + Xray log after an action, without losing the page. */
async function refreshOutbound() {
  try {
    const r = await api('/api/outbound');
    state.outbound = r.outbound;
    const logs = await api('/api/outbound/logs?lines=150');
    state.outboundLog = logs.content || '';
  } catch {
    /* the status badge already tells the operator something is wrong */
  }
}

function wireOutbound() {
  document.getElementById('obSave')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/outbound', { method: 'PUT', body: outboundBody() });
      state.outbound = r.outbound;
      toast('کانفیگ ذخیره شد', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  document.getElementById('obStart')?.addEventListener('click', async () => {
    const btn = document.getElementById('obStart');
    btn.disabled = true;
    btn.textContent = 'در حال فعال‌سازی…';
    try {
      // Save first: what the operator sees in the box is what gets started.
      const saved = await api('/api/outbound', { method: 'PUT', body: outboundBody() });
      state.outbound = saved.outbound;
      const r = await api('/api/outbound/start', { method: 'POST' });
      state.outbound = r.outbound;
      toast('مسیر خروجی فعال شد؛ SSH پنل از این پروکسی می‌رود', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    await refreshOutbound();
    render();
  });

  document.getElementById('obStop')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/outbound/stop', { method: 'POST' });
      state.outbound = r.outbound;
      toast('مسیر خروجی خاموش شد', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    render();
  });

  document.getElementById('obLogs')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/outbound/logs?lines=250');
      state.outboundLog = r.content || 'لاگی نیست';
    } catch (err) {
      state.outboundLog = err.message;
    }
    render();
  });

  document.getElementById('obTest')?.addEventListener('click', async () => {
    openModal('تست مسیر خروجی', '<div class="small muted">در حال تست…</div>', [
      { text: 'بستن', class: 'primary', onClick: closeModal },
    ]);
    try {
      const r = await api('/api/outbound/test', { method: 'POST' });
      const ipRow = `<div class="ok-box">اینترنت از مسیر پروکسی: <b class="mono">${esc(r.internet.ip || '—')}</b></div>`;
      const sshRow = r.ssh
        ? `<div class="${r.ssh.ok ? 'ok-box' : 'err-box'} mt">SSH به ${esc(r.ssh.server)} (<span class="mono">${esc(r.ssh.host)}</span>): ${r.ssh.ok ? 'موفق' : 'ناموفق'}<br><span class="small mono">${esc(r.ssh.output || '')}</span></div>`
        : '<div class="small muted mt">سرور خارجی ثبت نشده که SSH را تست کنم.</div>';
      openModal('تست مسیر خروجی', ipRow + sshRow, [{ text: 'بستن', class: 'primary', onClick: closeModal }]);
    } catch (err) {
      openModal('تست مسیر خروجی', `<div class="err-box">${esc(err.message)}</div>`, [
        { text: 'بستن', class: 'primary', onClick: closeModal },
      ]);
    }
  });
}

// ================================================================= servers
function pageServers() {
  const rows = state.servers
    .map((s) => {
      const st = s.lastStatus || {};
      const online = s.lastSeen && Date.now() - new Date(s.lastSeen).getTime() < 90000;
      const wv = st.waterwallVersion || null;
      // The panel targets a specific release. A core older than the target can
      // still work for older templates, so this is information, not a hard
      // error — but a mismatch is worth seeing at a glance.
      const vClass = !wv ? 'mute' : wv === state.versions?.current ? 'ok' : 'err';
      return `
      <tr>
        <td>
          <strong>${esc(s.name)}</strong><br>
          <span class="badge ${s.role === 'iran' ? 'ok' : ''}">${roleLabel(s.role)}</span>
        </td>
        <td class="ltr">${esc(s.sshUser)}@${esc(s.host)}:${s.sshPort}</td>
        <td class="ltr small">${esc(s.waterwallPath)}</td>
        <td>
          <span class="badge ${online ? 'ok' : 'mute'}">${online ? 'آنلاین' : 'آفلاین'}</span>
          <div class="small muted">${online ? esc(st.service || '') : 'گزارشی نشده'}</div>
        </td>
        <td class="ltr">
          <span class="badge ${vClass}" title="نسخه واتروال نصب‌شده روی این سرور">${wv ? esc(wv) : 'نامشخص'}</span>
        </td>
        <td class="ltr small">${st.publicIp ? esc(st.publicIp) : '—'}</td>
        <td class="small">${fmtDate(s.lastSeen)}</td>
        <td style="white-space:nowrap">
          <button class="sm" data-srv-up="${s.id}" title="بالا — اولویت زودتر">▲</button>
          <button class="sm" data-srv-down="${s.id}" title="پایین — اولویت دیرتر">▼</button>
          <button class="sm" data-srv-edit="${s.id}">ویرایش</button>
          <button class="sm" data-srv-probe="${s.id}">بررسی</button>
          <button class="sm" data-srv-logs="${s.id}">لاگ</button>
          <button class="sm" data-srv-conn="${s.id}">اتصال کلاینت</button>
          <button class="sm danger" data-srv-del="${s.id}">حذف</button>
        </td>
      </tr>`;
    })
    .join('');

  return `
  <div class="page-head">
    <h2>سرورها</h2>
    <span class="desc">سرور ایران، رله و خارج که واتروال روی آن‌ها اجرا می‌شود</span>
    <div class="spacer"></div>
    <button class="primary" id="addServer">➕ افزودن سرور</button>
  </div>

  <div class="card">
    <h3>📥 نصب روی سرور</h3>
    <p class="small muted" style="line-height:2">
      اسکریپت نصب، هم واتروال و هم ایجنت را می‌نویسد. اگر سرور به گیت‌هاب دسترسی ندارد،
      فایل‌ها را روی کامپیوتر خودتان بگیرید و با <span class="mono">--waterwall-zip</span> نصب کنید.
    </p>

    <h4 style="margin:14px 0 8px;font-size:12px;color:var(--accent)">نصب خودکار</h4>
    <pre class="code" style="direction:ltr;text-align:left">curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 \\
  ${esc(location.origin)}/install.sh -o /tmp/ww-install.sh && \\
sudo bash /tmp/ww-install.sh \\
  --panel-url ${esc(location.origin)} \\
  --agent-token AGENT_TOKEN</pre>
    <div class="small muted">توکن هر سرور جداست: در جدول بالا دکمه «ویرایش» را بزنید.</div>
    <div class="small muted" style="margin-top:6px">
      فایل اول دانلود می‌شود و بعد اجرا — اگر دانلود وسط کار قطع شود، نصبِ نیمه‌کاره جا نمی‌ماند.
      اگر <span class="mono">sudo</span> رمز می‌خواهد، اول <span class="mono">sudo -v</span> را اجرا کنید.
    </div>

    <h4 style="margin:18px 0 8px;font-size:12px;color:var(--accent)">نصب آفلاین</h4>
    <pre class="code" style="direction:ltr;text-align:left"># 1) روی کامپیوتر خودتان:
#    Waterwall-linux-gcc-x64-old-cpu.zip  و  agent.js  را دانلود کنید
scp Waterwall-linux-gcc-x64-old-cpu.zip agent.js root@SERVER_IP:/root/

# 2) روی سرور:
sudo ./install.sh --offline \\
  --waterwall-zip /root/Waterwall-linux-gcc-x64-old-cpu.zip \\
  --agent-file /root/agent.js \\
  --panel-url ${esc(location.origin)} \\
  --agent-token AGENT_TOKEN</pre>

    <div class="row" style="gap:8px;margin-top:12px">
      <a class="btn" href="/install.sh" download>⬇️ دانلود install.sh</a>
      <a class="btn" href="/install-agent.sh" download>⬇️ نصب‌کننده ایجنت</a>
      <a class="btn" href="/agent.js" download>⬇️ agent.js</a>
    </div>

    <details style="margin-top:14px">
      <summary class="small" style="cursor:pointer">نصب کاملاً دستی (بدون اسکریپت)</summary>
      <p class="small muted">
        راهنمای گام‌به‌گام برای وقتی که هیچ اسکریپتی قابل اجرا نیست: ساخت باینری،
        یونیت systemd، sysctl و عیب‌یابی. در فایل
        <span class="mono">docs/INSTALL-MANUAL.md</span> داخل ریپوزیتوری هست.
      </p>
    </details>
  </div>

${versionCardHtml()}

${upgradeCardHtml()}

  <div class="card">
    ${
      state.servers.length
        ? `<table><thead><tr>
            <th>نام</th><th>SSH</th><th>مسیر واتروال</th><th>وضعیت</th><th>نسخه واتروال</th><th>IP عمومی</th><th>آخرین گزارش</th><th></th>
          </tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty"><div class="ic">🖥️</div>هنوز سروری ثبت نشده است.<br>سرور ایران و سرور خارج را اضافه کنید.</div>'
    }
  </div>

  <div class="card">
    <h3>ℹ️ راهنما</h3>
    <ul class="small muted" style="line-height:2.1;padding-inline-start:20px">
      <li>هر سرور یک <b>Agent Token</b> مخصوص دارد. همان را روی سرور در متغیر محیطی <span class="mono">WW_AGENT_TOKEN</span> قرار دهید.</li>
      <li>اگر Agent Token را خالی بگذارید، پنل از طریق SSH (پورت و کلید) فایل‌ها را مستقیم می‌نویسد و سرویس را ری‌استارت می‌کند.</li>
      <li>پسورد SSH فقط اگر <span class="mono">sshpass</span> روی سیستم نصب باشد کار می‌کند؛ کلید SSH پیشنهاد می‌شود.</li>
    </ul>
  </div>`;
}

function serverForm(server = {}) {
  return `
  <div class="grid c2">
    <label class="f"><span class="lbl">نام <span class="req">*</span></span>
      <input type="text" id="f_name" value="${esc(server.name || '')}" placeholder="سرور ایران"></label>
    <label class="f"><span class="lbl">نقش <span class="req">*</span></span>
      <select id="f_role">
        <option value="iran" ${server.role === 'iran' ? 'selected' : ''}>سرور ایران (ورودی)</option>
        <option value="relay" ${server.role === 'relay' ? 'selected' : ''}>سرور رله (میانی)</option>
        <option value="foreign" ${server.role === 'foreign' || !server.role ? 'selected' : ''}>سرور خارج (خروجی)</option>
      </select></label>
  </div>
  <div class="grid c3">
    <label class="f"><span class="lbl">آدرس سرور <span class="req">*</span></span>
      <input type="text" id="f_host" value="${esc(server.host || '')}" placeholder="203.0.113.10"></label>
    <label class="f"><span class="lbl">پورت SSH</span>
      <input type="number" id="f_sshPort" value="${server.sshPort || 22}"></label>
    <label class="f"><span class="lbl">کاربر SSH</span>
      <input type="text" id="f_sshUser" value="${esc(server.sshUser || 'root')}"></label>
  </div>
  <div class="grid c2">
    <label class="f"><span class="lbl">مسیر کلید SSH</span>
      <input type="text" id="f_sshKeyPath" value="${esc(server.sshKeyPath || '')}" placeholder="/root/.ssh/id_ed25519"></label>
    <label class="f"><span class="lbl">رمز SSH (اختیاری، نیازمند sshpass)</span>
      <input type="password" id="f_sshPassword" value="${server.sshPassword === '***' ? '' : esc(server.sshPassword || '')}"></label>
  </div>
  <div class="grid c3">
    <label class="f"><span class="lbl">مسیر نصب واتروال</span>
      <input type="text" id="f_waterwallPath" value="${esc(server.waterwallPath || '/opt/waterwall')}"></label>
    <label class="f"><span class="lbl">نام سرویس systemd</span>
      <input type="text" id="f_serviceName" value="${esc(server.serviceName || 'waterwall')}"></label>
    <label class="f"><span class="lbl">&nbsp;</span>
      <label class="switch" style="margin-top:9px">
        <input type="checkbox" id="f_agentEnabled" ${server.agentEnabled ? 'checked' : ''}>
        <span class="track"></span>
        <span>استفاده از Agent</span>
      </label></label>
  </div>
  <div id="agentTokenBox" class="warn-box" style="display:none"></div>`;
}

function readServerForm() {
  return {
    name: $('#f_name').value.trim(),
    role: $('#f_role').value,
    host: $('#f_host').value.trim(),
    sshPort: Number($('#f_sshPort').value) || 22,
    sshUser: $('#f_sshUser').value.trim() || 'root',
    sshKeyPath: $('#f_sshKeyPath').value.trim(),
    sshPassword: $('#f_sshPassword').value,
    waterwallPath: $('#f_waterwallPath').value.trim() || '/opt/waterwall',
    serviceName: $('#f_serviceName').value.trim() || 'waterwall',
    agentEnabled: $('#f_agentEnabled').checked,
  };
}

async function saveServer(existing) {
  const payload = readServerForm();
  if (!payload.name || !payload.host) {
    toast('نام و آدرس سرور الزامی است', 'err');
    return;
  }
  try {
    if (existing) {
      const r = await api(`/api/servers/${existing.id}`, { method: 'PATCH', body: payload });
      state.servers = state.servers.map((s) => (s.id === existing.id ? r.server : s));
      toast('سرور بروزرسانی شد', 'ok');
    } else {
      const r = await api('/api/servers', { method: 'POST', body: payload });
      state.servers.push(r.server);
      toast('سرور اضافه شد', 'ok');
    }
    closeModal();
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function showAgentSetup(server) {
  openModal(
    `اتصال کلاینت — ${server.name}`,
    `
    <p class="small muted">این اسکریپت را روی سرور اجرا کنید. ایجنت هر چند ثانیه کانفیگ را از پنل می‌گیرد، می‌نویسد و سرویس را ری‌استارت می‌کند.</p>
    <label class="f"><span class="lbl">توکن Agent</span>
      <input type="text" id="agentTokenOut" class="mono" value="${esc(server.agentToken || '')}" readonly></label>
    <label class="f"><span class="lbl">دستور نصب (کپی کنید)</span>
      <textarea id="agentCmd" readonly style="min-height:150px">curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 ${location.origin}/install-agent.sh -o /tmp/ww-install-agent.sh && sudo WW_PANEL_URL="${location.origin}" WW_AGENT_TOKEN="${server.agentToken || ''}" bash /tmp/ww-install-agent.sh</textarea></label>
    <p class="small muted">اگر پنل را روی HTTP ساده اجرا می‌کنید، از یک reverse proxy با HTTPS استفاده کنید تا توکن در مسیر رمزنشده نباشد.</p>`,
    [{ text: 'کپی توکن', class: '', onClick: () => copy(server.agentToken, 'توکن') }, { text: 'بستن', class: 'primary', onClick: closeModal }],
  );
}

async function probeServer(id) {
  const server = state.servers.find((s) => s.id === id);
  openModal('بررسی سرور', '<div class="logbox">در حال اتصال…</div>', [{ text: 'بستن', class: '', onClick: closeModal }]);
  try {
    const r = await api(`/api/servers/${id}/probe`);
    $('#modalBody').innerHTML = `
      <div class="kv"><span>نتیجه SSH</span><span>${r.host.ok ? '✅ موفق' : '❌ ناموفق'}</span></div>
      <div class="kv"><span>کرنل</span><span class="mono">${esc(r.host.kernel || r.host.error || '—')}</span></div>
      <div class="kv"><span>هسته CPU</span><span>${r.host.cores ?? '—'}</span></div>
      <div class="kv"><span>آپ‌تایم</span><span>${esc(r.host.uptime || '—')}</span></div>
      <div class="kv"><span>IP عمومی</span><span class="mono">${esc(r.host.ip || '—')}</span></div>
      <hr class="sep">
      <div class="kv"><span>سرویس</span><span class="badge ${r.service.active === 'active' ? 'ok' : 'err'}">${esc(r.service.active)}</span></div>
      <div class="kv"><span>اجرای خودکار</span><span>${esc(r.service.enabled)}</span></div>
      <div class="kv"><span>فعال از</span><span>${esc(r.service.since || '—')}</span></div>
      <div class="row mt">
        <button class="sm" data-svc="restart">ری‌استارت</button>
        <button class="sm" data-svc="start">شروع</button>
        <button class="sm" data-svc="stop">توقف</button>
      </div>`;
    $$('#modalBody [data-svc]').forEach((b) => {
      b.onclick = async () => {
        try {
          const res = await api(`/api/servers/${id}/service`, { method: 'POST', body: { action: b.dataset.svc } });
          toast(`${b.dataset.svc}: ${res.result.active || 'done'}`, 'ok');
          $('#modalBody').insertAdjacentHTML('afterbegin', `<div class="ok-box">${esc(res.result.output || 'ok')}</div>`);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    });
  } catch (err) {
    $('#modalBody').innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
  }
}

/**
 * Service log viewer for one server.
 *
 * The panel reads `journalctl` over SSH rather than keeping a log copy, so this
 * always reflects the unit as it is now — including a service that failed to
 * start after the last deploy.
 */
async function showServerLogs(id) {
  const server = state.servers.find((s) => s.id === id);
  if (!server) return;
  const service = server.serviceName || 'waterwall';
  openModal(
    `لاگ سرویس — ${server.name}`,
    `<div class="row" style="align-items:flex-end;gap:8px;flex-wrap:wrap">
       <label class="f" style="flex:1;min-width:180px"><span class="lbl">نام سرویس</span>
         <input type="text" id="logService" class="mono" dir="ltr" value="${esc(service)}"></label>
       <label class="f" style="width:110px"><span class="lbl">تعداد خط</span>
         <input type="number" id="logLines" value="200" min="20" max="1000"></label>
       <button class="sm" id="logRefresh">🔄 به‌روزرسانی</button>
     </div>
     <div id="logStatus" class="mt"></div>
     <h4 style="margin:14px 0 6px;font-size:12px;color:var(--accent)">وضعیت سرویس (systemctl status)</h4>
     <pre class="code" id="logStatusText" style="direction:ltr;text-align:left;max-height:260px;overflow:auto;font-size:12px;margin:0">در حال خواندن…</pre>
     <h4 style="margin:14px 0 6px;font-size:12px;color:var(--accent)">ژورنال سرویس</h4>
     <pre class="code" id="logOut" style="direction:ltr;text-align:left;max-height:260px;overflow:auto;font-size:12px;margin:0">در حال خواندن…</pre>`,
    [{ text: 'بستن', class: 'primary', onClick: closeModal }],
  );

  const out = document.getElementById('logOut');
  const statusBox = document.getElementById('logStatusText');
  const badge = document.getElementById('logStatus');
  const load = async () => {
    out.textContent = 'در حال خواندن از سرور…';
    statusBox.textContent = 'در حال خواندن از سرور…';
    badge.innerHTML = '';
    try {
      const q = new URLSearchParams({
        service: document.getElementById('logService').value.trim() || service,
        lines: document.getElementById('logLines').value || '200',
      });
      const r = await api(`/api/servers/${id}/logs?${q.toString()}`);
      const cls = r.status === 'active' ? 'ok' : r.status === 'failed' ? 'err' : 'mute';
      badge.innerHTML =
        `<span class="badge ${cls}">${esc(r.status || 'unknown')}</span>` +
        ` <span class="badge ${r.enabled === 'enabled' ? 'ok' : 'mute'}">${esc(r.enabled || 'unknown')}</span>` +
        (r.error ? ` <span class="small muted">${esc(r.error)}</span>` : '');
      statusBox.textContent = r.statusText && r.statusText.trim() ? r.statusText : 'systemctl status خروجی نداد.';
      out.textContent =
        r.content && r.content.trim()
          ? r.content
          : 'لاگی برنگشت: یا سرویس خاموش است، یا journald برای این unit چیزی ندارد.';
    } catch (err) {
      badge.innerHTML = '<span class="badge err">خطا</span>';
      out.textContent = err.message;
      statusBox.textContent = '—';
    }
  };
  document.getElementById('logRefresh').addEventListener('click', load);
  document.getElementById('logService').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') load();
  });
  load();
}

// ================================================================ tunnels
function pageTunnels() {
  const rows = state.tunnels
    .map((t) => {
      const tpl = state.templates.find((x) => x.id === t.template);
      const exits = foreignList(t.targetServers?.foreign).length;
      return `
      <tr>
        <td><strong>${esc(t.name)}</strong>${t.notes ? `<br><span class="small muted">${esc(t.notes)}</span>` : ''}</td>
        <td><span class="badge">${tpl?.icon || ''} ${esc(tpl?.titleFa || t.template)}</span>${exits > 1 ? `<br><span class="small muted">${exits} سرور خارج</span>` : ''}</td>
        <td><span class="badge ${t.enabled ? 'ok' : 'mute'}">${t.enabled ? 'فعال' : 'غیرفعال'}</span></td>
        <td class="small">${fmtDate(t.updatedAt)}</td>
        <td style="white-space:nowrap">
          <button class="sm primary" data-tn-open="${t.id}">✏️ ویرایش</button>
          <button class="sm" data-tn-preview="${t.id}">پیش‌نمایش</button>
          <button class="sm" data-tn-del="${t.id}">حذف</button>
        </td>
      </tr>`;
    })
    .join('');

  return `
  <div class="page-head">
    <h2>تانل‌ها</h2>
    <span class="desc">${state.tunnels.length} تونل تعریف شده</span>
    <div class="spacer"></div>
    <button class="primary" id="newTunnel">➕ تونل جدید</button>
  </div>
  <div class="card">
    ${
      state.tunnels.length
        ? `<table><thead><tr><th>نام</th><th>سناریو</th><th>وضعیت</th><th>آخرین تغییر</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty"><div class="ic">🔗</div>هنوز تانلی ساخته نشده است.<br>با «تونل جدید» شروع کنید.</div>'
    }
  </div>`;
}

// ------------------------------------------------------------ tunnel detail
function openTunnel(id) {
  state.currentTunnel = state.tunnels.find((t) => t.id === id);
  state.draft = { ...state.currentTunnel, options: { ...state.currentTunnel.options } };
  state.preview = null;
  go('edit');
}

function pageEditTunnel() {
  const t = state.draft;
  if (!t) return pageTunnels();
  const tpl = state.templates.find((x) => x.id === t.template);
  const p = state.preview;
  const iran = state.servers.filter((s) => s.role === 'iran');
  const foreign = state.servers.filter((s) => s.role === 'foreign');
  const relay = state.servers.filter((s) => s.role === 'relay');
  const hasRelay = (tpl?.sides || []).includes('relay');
  const serverOpts = (list, selected) =>
    list.length
      ? list
          .map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`)
          .join('')
      : '<option value="">— ثبت نشده —</option>';
  const groups = {};
  for (const f of tpl?.fields || []) {
    const g = f.group || 'general';
    groups[g] = groups[g] || [];
    groups[g].push(f);
  }
  const foreignSelected = foreignList(t.targetServers?.foreign);

  return `
  <div class="page-head">
    <h2>${esc(t.name)}</h2>
    <span class="desc">${esc(tpl?.titleFa || t.template)}</span>
    <div class="spacer"></div>
    <button id="editBack">بازگشت</button>
    <button class="primary" id="editSave">💾 ذخیره</button>
    <button class="ok" id="editApply">🚀 ذخیره و اعمال روی سرورها</button>
  </div>

  <div class="card">
    <h3>⚙️ تنظیمات تونل</h3>
    <p class="small muted">همهٔ فیلدهایی که موقع ساخت پر کردید اینجاست. مقدارها را همین‌جا عوض کنید و «💾 ذخیره» را بزنید. تونل‌های فعال حداکثر ۱۵ ثانیه بعد خودکار روی هر دو سرور اعمال می‌شوند؛ اگر می‌خواهید همین حالا اعمال شود «🚀 ذخیره و اعمال روی سرورها» را بزنید.</p>
    <div class="grid c2">
      <label class="f"><span class="lbl">نام تونل <span class="req">*</span></span>
        <input type="text" id="et_name" value="${esc(t.name)}"></label>
      <label class="f"><span class="lbl">وضعیت</span>
        <label class="switch"><input type="checkbox" id="et_enabled" ${t.enabled ? 'checked' : ''}><span class="track"></span><span>${t.enabled ? 'فعال' : 'غیرفعال'}</span></label>
      </label>
    </div>
    <label class="f"><span class="lbl">توضیحات</span><input type="text" id="et_notes" value="${esc(t.notes || '')}"></label>
    <div class="grid c2">
      <label class="f"><span class="lbl">سرور ایران</span>
        <select id="et_iran">${serverOpts(iran, t.targetServers?.iran)}</select></label>
      ${
        hasRelay
          ? `<label class="f"><span class="lbl">سرور رله <span class="badge ok">میانی</span></span>
        <select id="et_relay">${serverOpts(relay, t.targetServers?.relay)}</select></label>`
          : tpl?.multiExit || tpl?.sides?.includes('foreign') === false
            ? ''
            : `<label class="f"><span class="lbl">سرور خارج</span>
        <select id="et_foreign">${serverOpts(foreign, t.targetServers?.foreign)}</select></label>`
      }
    </div>
    ${
      tpl?.multiExit
        ? `<label class="f"><span class="lbl">سرورهای خارج <span class="badge ok">چند-سروری</span></span>${foreignPickerHtml(
            'et',
            foreign,
            foreignSelected.length ? foreignSelected : foreign.length ? [foreign[0].id] : [],
          )}</label>`
        : ''
    }
    <p class="small muted">سناریو: <b>${esc(tpl?.titleFa || t.template)}</b> — برای عوض کردن سناریو یک تونل جدید بسازید.</p>

    ${Object.entries(groups)
      .map(
        ([g, fields]) => `<fieldset class="group">
        <legend>${esc(groupLabel(g))}</legend>
        ${fields.map((f) => fieldHtml(f, (t.options || {})[f.key])).join('')}
      </fieldset>`,
      )
      .join('')}
  </div>

  <div class="card">
    <h3>📄 کانفیگ تولیدشده</h3>
    ${
      !p
        ? '<div class="empty"><div class="ic">📄</div>برای دیدن کانفیگ، روی «پیش‌نمایش» بزنید.</div>'
        : p.problems?.length
          ? `<div class="err-box"><b>${p.problems.length} مشکل:</b><br>${p.problems.map(esc).join('<br>')}</div>`
          : '<div class="ok-box">✓ کانفیگ معتبر است و زنجیره‌ها کامل هستند.</div>'
    }
    ${
      p?.warnings?.length
        ? `<div class="warn-box"><b>هشدارها</b><br>${p.warnings.map((w) => `• ${esc(w)}`).join('<br>')}</div>`
        : ''
    }
    ${
      p?.notes?.length
        ? `<div class="card" style="background:var(--bg-2);margin-bottom:12px"><b class="small">نکات</b><ul class="small muted" style="line-height:2;padding-inline-start:18px">${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`
        : ''
    }
    ${previewHtml(p)}
    <div class="row mt">
      <button id="doPreview">🔄 پیش‌نمایش</button>
      <button id="doRegen">🎲 بازتولید رمزها</button>
      <button id="doLogs">📋 لاگ سرور خارج</button>
      <button id="doClient">🔗 اطلاعات اتصال کلاینت</button>
      <button id="doRestart">♻️ ری‌استارت سرویس‌ها</button>
      <button id="doDry">🧪 اعمال آزمایشی (dry-run)</button>
    </div>
  </div>

  ${clientHtml(p)}
  ${protocolScanHtml(p, t)}
  ${usersHtml(t)}`;
}

/** Protocol-number scanner: only templates that define a probe show this. */
function protocolScanHtml(p, t) {
  const probe = p?.probe;
  if (!probe) return '';
  const list = (probe.protocols || []).join(', ');
  return `
  <div class="card">
    <h3>🔢 تست شماره پروتکل</h3>
    <p class="small muted">
      هر شماره‌ای که در تنظیمات مجاز است لزوماً روی مسیر شما باز نیست. این دکمه پکت واقعی IPv4 با هر شماره می‌فرستد
      و نتیجه را نشان می‌دهد تا بدانید تونل روی کدام شماره‌ها کار می‌کند.
    </p>
    <div class="row">
      <label class="f" style="flex:1;min-width:240px;margin:0">
        <span class="lbl">شماره‌های قابل تست</span>
        <input type="text" id="psList" value="${esc(list)}">
      </label>
      <label class="f" style="width:150px;margin:0">
        <span class="lbl">مهلت هر تست (ms)</span>
        <input type="number" id="psTimeout" value="${probe.timeoutMs || 1500}">
      </label>
      <button class="primary" id="doProtocolScan" style="margin-top:22px">شروع تست</button>
    </div>
    <div class="small muted mt" id="psHint">
      نیازمند اجرای پنل با دسترسی root (یا CAP_NET_RAW)، چون از raw socket استفاده می‌شود.
    </div>
    <div id="psOut" class="mt"></div>
  </div>`;
}

async function runProtocolScan() {
  const out = $('#psOut');
  const list = String($('#psList').value || '')
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!list.length) {
    out.innerHTML = '<div class="err-box">حداقل یک شماره بین ۰ تا ۲۵۵ وارد کنید.</div>';
    return;
  }
  out.innerHTML = '<div class="small muted">در حال تست… این کار ممکن است چند ثانیه طول بکشد.</div>';

  try {
    const r = await api(`/api/tunnels/${state.draft.id}/protocol-scan`, {
      method: 'POST',
      body: { protocols: list, timeout: Number($('#psTimeout').value) || 1500 },
    });
    renderProtocolResults(r);
  } catch (err) {
    out.innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
  }
}

function renderProtocolResults(r) {
  const out = $('#psOut');
  if (!r.ok) {
    out.innerHTML = `<div class="err-box">${esc(r.error || 'تست ممکن نشد')}</div>`;
    return;
  }
  const rows = (r.results || [])
    .slice()
    .sort((a, b) => Number(b.ok) - Number(a.ok) || a.protocol - b.protocol)
    .map(
      (x) => `<tr>
        <td class="ltr"><b>${x.protocol}</b></td>
        <td><span class="badge ${x.ok ? 'ok' : 'err'}">${x.ok ? 'باز' : 'بسته'}</span></td>
        <td>${x.ok ? `${x.hits} از ${x.attempts} پاسخ` : esc(x.error || '—')}</td>
        <td>${x.ok ? `${x.latencyMs} ms` : '—'}</td>
        <td>${x.inUseByTunnel ? '<span class="badge mute">در تونل فعلی</span>' : ''}</td>
      </tr>`,
    )
    .join('');

  const s = r.summary || {};
  const best = s.best;
  out.innerHTML = `
    <div class="${s.open ? 'ok-box' : 'err-box'}">
      از ${s.tested} شماره تست‌شده: <b>${s.open}</b> باز و <b>${s.blocked}</b> بسته.
      ${best !== null && best !== undefined ? ` بهترین گزینه: <b class="mono">${best}</b>` : ''}
      ${s.open ? '' : ' — هیچ‌کدام پاسخ ندادند؛ ممکن است پکت‌ها روی مسیر فیلتر شوند یا ICMP خارج از دسترس باشد.'}
    </div>
    <table><thead><tr>
      <th>شماره</th><th>وضعیت</th><th>پاسخ</th><th>تأخیر</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="small muted mt">مبدأ پکت‌ها: <span class="mono">${esc(r.source || '—')}</span> — مقصد: <span class="mono">${esc(r.destination || '—')}</span></p>`;
}

function previewHtml(p) {
  if (!p || !p.bundles) return '';
  const sides = Object.keys(p.bundles);
  const side = sides.includes(state.activePreviewTab) ? state.activePreviewTab : sides[0];
  const files = p.bundles[side];
  const names = Object.keys(files);
  const active = state.previewFile && files[state.previewFile] ? state.previewFile : names[0];

  return `
  <div class="tabs">
    ${sides.map((s) => `<span class="tab ${s === side ? 'active' : ''}" data-side="${s}">${sideLabel(s)}</span>`).join('')}
    ${names.map((f) => `<span class="tab ${f === active ? 'active' : ''}" data-file="${esc(f)}">${esc(f)}</span>`).join('')}
  </div>
  <pre class="code" id="previewCode">${highlight(files[active])}</pre>
  <div class="row mt">
    <button class="sm" id="copyFile">📋 کپی این فایل</button>
    <button class="sm" id="downloadAll">⬇️ دانلود همه فایل‌ها</button>
    <span class="small muted">فایل‌های سمت ${roleLabel(side)}</span>
  </div>`;
}

function clientHtml(p) {
  if (!p?.client) return '';
  return `
  <div class="card">
    <h3>🔗 اطلاعات اتصال کلاینت</h3>
    ${
      p.client.links?.length
        ? `<table><thead><tr><th>روش</th><th>لینک</th><th></th></tr></thead><tbody>${p.client.links
            .map(
              (l) => `<tr>
                <td>${esc(l.label)}</td>
                <td class="ltr small">${esc(l.url || '—')}</td>
                <td>${l.url ? `<button class="sm" data-copy="${esc(l.url)}">کپی</button>` : ''}</td>
              </tr>`,
            )
            .join('')}</tbody></table>`
        : '<p class="small muted">این سناریو لینک کلاینت ندارد.</p>'
    }
    ${p.client.text ? `<label class="f mt"><span class="lbl">تنظیمات آماده</span><textarea id="clientText" readonly style="min-height:120px">${esc(p.client.text)}</textarea></label>` : ''}
    ${
      p.client.instructions?.length
        ? `<ul class="small muted" style="line-height:2;padding-inline-start:18px">${p.client.instructions.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        : ''
    }
  </div>`;
}

function usersHtml(t) {
  const tpl = state.templates.find((x) => x.id === t.template);
  if (!tpl?.fields.some((f) => f.type === 'users')) return '';
  const users = t.options?.users || [];
  return `
  <div class="card">
    <h3>👥 کاربران</h3>
    <p class="small muted">این کاربران در فایل <span class="mono">users.json</span> برای AuthenticationServer نوشته می‌شوند و کلاینت سمت ایران آن‌ها را دریافت می‌کند.</p>
    <table>
      <thead><tr><th>نام کاربری</th><th>رمز</th><th>سقف دستگاه</th><th>سقف ترافیک (GB)</th><th>انقضا</th><th>فعال</th><th></th></tr></thead>
      <tbody>
        ${
          users.length
            ? users
                .map(
                  (u, i) => `<tr>
            <td class="mono">${esc(u.username)}</td>
            <td class="mono small">${esc(u.password || '')}</td>
            <td>${u.deviceLimit ?? '—'}</td>
            <td>${u.totalLimitGb ?? '—'}</td>
            <td class="small">${u.expiresAt ? fmtDate(u.expiresAt) : '—'}</td>
            <td><span class="badge ${u.enabled !== false ? 'ok' : 'err'}">${u.enabled !== false ? 'بله' : 'خیر'}</span></td>
            <td><button class="sm danger" data-user-del="${i}">حذف</button></td>
          </tr>`,
                )
                .join('')
            : '<tr><td colspan="7" class="muted small">کاربری تعریف نشده است.</td></tr>'
        }
      </tbody>
    </table>
    <div class="row mt">
      <input type="text" id="newUserName" placeholder="نام کاربری" style="max-width:200px">
      <input type="text" id="newUserPass" placeholder="رمز (خالی = خودکار)" style="max-width:200px">
      <input type="number" id="newUserLimit" placeholder="سقف ترافیک GB" style="max-width:170px">
      <button class="primary" id="addUser">افزودن کاربر</button>
    </div>
  </div>`;
}

async function saveTunnel(silent = false) {
  const t = state.draft;
  if (!t) return;
  const tpl = state.templates.find((x) => x.id === t.template);
  const body = { name: t.name, notes: t.notes, enabled: t.enabled, options: t.options };
  // On the detail page the settings form is the source of truth. Without it
  // (nothing else calls this today) the draft values are sent unchanged.
  if ($('#et_name') && tpl) {
    const name = $('#et_name').value.trim();
    if (!name) {
      toast('نام تونل را وارد کنید', 'err');
      return null;
    }
    body.name = name;
    body.notes = $('#et_notes').value.trim();
    body.enabled = $('#et_enabled').checked;
    // Merge over the stored options: keys a template's `ensureOptions` added
    // (WireGuard keypairs and friends) are not form fields and must survive.
    body.options = { ...t.options, ...collectForm(tpl, { keepEmpty: true, fallback: t.options }) };
    body.targetServers = readTargets('et');
    if ($('#et_foreign_list') && !body.targetServers.foreign.length) {
      toast('حداقل یک سرور خارج انتخاب کنید', 'err');
      return null;
    }
    if ($('#et_relay') && !body.targetServers.relay) {
      toast('یک سرور رله انتخاب کنید (یا ابتدا آن را در صفحهٔ سرورها ثبت کنید)', 'err');
      return null;
    }
  }
  try {
    const r = await api(`/api/tunnels/${t.id}`, {
      method: 'PATCH',
      body,
    });
    state.draft = { ...r.tunnel, options: { ...r.tunnel.options } };
    state.currentTunnel = r.tunnel;
    state.tunnels = state.tunnels.map((x) => (x.id === r.tunnel.id ? r.tunnel : x));
    if (!silent) toast('ذخیره شد', 'ok');
    return r.tunnel;
  } catch (err) {
    toast(err.message, 'err');
    if (err.problems) toast(err.problems.join(' | '), 'err');
    return null;
  }
}

async function doPreview() {
  const t = state.draft;
  if (!t) return;
  const tpl = state.templates.find((x) => x.id === t.template);
  // Preview what the form holds right now, not the values of the last save.
  const options =
    $('#et_name') && tpl ? { ...t.options, ...collectForm(tpl, { keepEmpty: true, fallback: t.options }) } : t.options;
  const targetServers = $('#et_name') ? readTargets('et') : t.targetServers;
  try {
    const r = await api('/api/preview', {
      method: 'POST',
      body: { template: t.template, name: $('#et_name')?.value.trim() || t.name, options, targetServers },
    });
    state.draft.targetServers = targetServers;
    state.preview = r;
    state.activePreviewTab = Object.keys(r.bundles || {})[0] || 'iran';
    state.previewFile = null;
    if (r.optionsPatch) {
      // Persist generated secrets (WireGuard keypairs) so they stay stable.
      await api(`/api/tunnels/${t.id}`, { method: 'PATCH', body: { options: { ...options, ...r.optionsPatch } } });
      state.draft.options = { ...options, ...r.optionsPatch };
    } else {
      state.draft.options = options;
    }
    render();
    if (r.problems?.length) toast('کانفیگ مشکل دارد', 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/**
 * Post-deploy reachability report.
 *
 * A tunnel that uploaded cleanly can still be dead because a firewall never let
 * the link port through. Showing the verdict, and the exact rule that fixes it,
 * is the difference between "it says deployed but nothing works" and a one-line
 * fix the user can paste.
 *
 * The rule is not just shown, it can be applied: the panel holds the SSH key
 * and the endpoint only accepts scoped `ufw allow` rules, so a blocked port is
 * one click instead of an SSH session.
 */
function reachabilityHtml(r, tunnelId) {
  if (!r) return '';
  if (r.error) return `<div class="err-box">بررسی دسترسی انجام نشد: ${esc(r.error)}</div>`;

  const VERDICT = {
    open: ['باز', 'ok'],
    refused: ['بسته (چیزی گوش نمی‌دهد)', 'err'],
    filtered: ['فیلترشده', 'err'],
    'no-egress': ['بدون دسترسی به بیرون', 'err'],
    unknown: ['نامشخص', ''],
    invalid: ['پورت نامعتبر', 'err'],
  };
  const row = (label, leg) => {
    if (!leg) return '';
    const [text, cls] = VERDICT[leg.verdict] || ['?', ''];
    return `<tr>
      <td>${esc(label)}</td>
      <td class="ltr">${esc(leg.from)} → ${esc(leg.to)}</td>
      <td class="ltr">${leg.port}</td>
      <td><span class="badge ${cls}">${esc(text)}</span></td>
    </tr>`;
  };

  const problems = (r.problems || [])
    .map((p, i) => {
      // Only a rule the panel derived itself is offered back as a button; the
      // endpoint refuses anything else by shape, so this stays an allow-only
      // shortcut and never becomes a way to run a command.
      const apply = p.fix
        ? `<button class="small" data-fix="${esc(p.fix)}" data-fix-i="${i}" style="margin-top:6px">⚡ اعمال این قانون</button>
           <span class="small muted" data-fix-out="${i}"></span>`
        : '';
      return `<div class="err-box">
        ${esc(p.message)}
        ${p.fix ? `<br><span class="small">رفع: <code class="mono" style="direction:ltr;display:inline-block">${esc(p.fix)}</code></span><br>${apply}` : ''}
      </div>`;
    })
    .join('');

  const good = r.ok
    ? '<div class="ok-box">✓ هر دو سرور به پورت‌های مورد نیاز یکدیگر دسترسی دارند.</div>'
    : '';

  return `<div style="margin-top:14px" data-reach="${esc(tunnelId || '')}">
    <h4 style="margin:0 0 8px;font-size:12px;color:var(--accent)">🔗 بررسی دسترسی بین دو سرور</h4>
    <table>
      <thead><tr><th>مسیر</th><th>جهت</th><th>پورت</th><th>وضعیت</th></tr></thead>
      <tbody>
        ${row('لینک بین دو سرور', r.link)}
        ${row('پورت کاربران', r.entry)}
      </tbody>
    </table>
    <p class="small muted" style="margin:8px 0">
      فایروال ایران: <span class="mono">${esc(r.firewalls?.iran || '—')}</span><br>
      فایروال خارج: <span class="mono">${esc(r.firewalls?.foreign || '—')}</span>
    </p>
    ${good}${problems}
  </div>`;
}

/**
 * Apply a firewall rule the reachability check suggested.
 *
 * The command is taken straight from the report rather than from any field the
 * user could edit, which keeps this one click and keeps the server side's shape
 * check meaningful.
 */
async function doFirewallFix(btn) {
  const box = document.querySelector(`[data-fix-out="${btn.dataset.fixI}"]`);
  const tunnelId = btn.closest('[data-reach]')?.dataset.reach;
  if (!tunnelId || !box) return;

  box.textContent = 'در حال اعمال…';
  box.className = 'small muted';
  btn.disabled = true;
  try {
    const r = await api(`/api/tunnels/${tunnelId}/fix-firewall`, {
      method: 'POST',
      body: { command: btn.dataset.fix },
    });
    box.textContent = `✓ روی ${esc(r.server)} اعمال شد`;
    box.className = 'small';
    btn.remove();
  } catch (err) {
    box.textContent = `✗ ${err.message}`;
    box.className = 'small';
    btn.disabled = false;
  }
}

/** Report the automatic service split (or, on dry-run, the plan for it). */
function isolationHtml(iso, dryRun) {
  if (!iso) return '';
  const clones = iso.clones || [];
  const plan = iso.plan || [];
  const skipped = iso.skipped || [];
  if (!clones.length && !plan.length && !skipped.length) return '';
  const rows = [];
  if (dryRun && plan.length) {
    rows.push(
      `<div class="warn-box"><b>سرویس جداگانه لازم است</b><br>${plan
        .map(
          (row) =>
            `• ${sideLabel(row.side)}: «${esc(row.server.name)}» همین حالا در تونل ${row.sharedWith
              .map((t) => `«${esc(t.name)}»`)
              .join('، ')} استفاده می‌شود؛ هنگام اعمال، یک سرویس جدا (${esc(row.server.serviceName || 'waterwall')}-2) برای این تونل ساخته می‌شود.`,
        )
        .join('<br>')}</div>`,
    );
  }
  if (clones.length) {
    rows.push(
      `<div class="ok-box"><b>سرویس مستقل ساخته شد</b><br>${clones
        .map(
          (row) =>
            `• ${sideLabel(row.side)}: ${esc(row.from.name)} → <span class="mono">${esc(row.server.serviceName)}</span> در <span class="mono">${esc(row.server.waterwallPath)}</span>`,
        )
        .join('<br>')}</div>`,
    );
  }
  if (skipped.length) {
    rows.push(
      `<div class="err-box"><b>سرویس مستقل ساخته نشد</b><br>${skipped
        .map((row) => `• ${sideLabel(row.side)} «${esc(row.server.name)}»: ${esc(row.reason)}`)
        .join('<br>')}</div>`,
    );
  }
  return rows.join('');
}

/**
 * Report the ports the panel moved on its own.
 *
 * A second tunnel on a box that already runs one cannot have the same
 * listening port: the second WaterWall process would fail to bind and the
 * tunnel would never come up. The panel moves the newcomer to a free port,
 * and this is where the operator finds out which number it ended up with.
 */
function portFixHtml(fix) {
  if (!fix) return '';
  const moved = fix.moved || [];
  if (!moved.length) return '';
  const rows = moved.map(
    (m) =>
      `• ${sideLabel(m.side)} روی «${esc(m.server || '—')}»: <span class="mono">${esc(
        m.key,
      )}</span> از <span class="mono">${m.from}</span> به <span class="mono">${m.to}</span> تغییر کرد ` +
      `<span class="small muted">(پورت قبلی را تونل دیگری روی همین سرور گرفته بود)</span>`,
  );
  return `<div class="warn-box"><b>پورت به‌صورت خودکار جابه‌جا شد</b><br>${rows.join(
    '<br>',
  )}<br><span class="small">پورت جدید را در لینک‌های کلاینت و در فایروال سرور ایران در نظر بگیرید.</span></div>`;
}

async function doApply(dryRun = false) {
  const t = state.draft;
  if (!t) return;
  const saved = await saveTunnel(true);
  if (!saved) return;
  try {
    const r = await api(`/api/tunnels/${t.id}/apply`, {
      method: 'POST',
      body: { dryRun, restart: !dryRun },
    });
    const lines = Object.entries(r.results)
      .map(([side, res]) => {
        const label = sideLabel(side);
        const detail = res.servers
          ? `${res.servers.map((p) => `${p.ok ? '✓' : '✗'} ${esc(p.server)}${p.error ? ` — ${esc(p.error)}` : ''}`).join('<br>')}${
              res.files || res.uploaded ? `<br><span class="small muted">${esc((res.files || res.uploaded).join(', '))}</span>` : ''
            }`
          : `${esc(res.dryRun ? 'dry-run OK — ' : '')}${esc((res.files || res.uploaded || []).join(', '))}${
              res.service?.output ? `<br>سرویس: ${esc(res.service.output)}` : ''
            }`;
        return res.ok
          ? `<div class="ok-box">${label}${res.servers ? ` (${res.servers.length} سرور): ` : ': '}${detail}</div>`
          : `<div class="err-box">${label}: ${detail || esc(res.error || '')}</div>`;
      })
      .join('');
    openModal(
      dryRun ? 'اعمال آزمایشی' : 'نتیجه اعمال',
      (lines || '<p class="muted">چیزی برای نمایش نیست.</p>') +
        isolationHtml(r.isolation, dryRun) +
        portFixHtml(r.portFix) +
        reachabilityHtml(r.reachability, t.id),
      [{ text: 'بستن', class: 'primary', onClick: closeModal }],
    );
    if (r.isolation?.changed || r.portFix?.changed) {
      // The apply switched this tunnel to freshly created server records and
      // may have moved a port. Pull the new state so the next save/edit does
      // not write the old values back.
      const fresh = await api('/api/bootstrap');
      state.servers = fresh.servers;
      state.tunnels = fresh.tunnels;
      const updated = fresh.tunnels.find((x) => x.id === t.id);
      if (updated) {
        state.draft = { ...updated, options: { ...updated.options } };
        state.currentTunnel = updated;
      }
    }
    if (r.ok && !r.reachability?.problems?.length) toast('روی سرورها اعمال شد', 'ok');
    else if (r.ok) toast('اعمال شد، ولی ارتباط دو سرور برقرار نیست', 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function showLogs() {
  const t = state.draft;
  openModal('لاگ سرور خارج', '<div class="logbox">در حال خواندن…</div>', [{ text: 'بستن', class: '', onClick: closeModal }]);
  try {
    const r = await api(`/api/tunnels/${t.id}/logs?side=foreign&lines=200`);
    $('#modalBody').innerHTML = r.ok
      ? `<pre class="logbox">${esc(r.content || '(خالی)')}</pre>`
      : `<div class="err-box">${esc(r.error || 'ناموفق')}</div>`;
  } catch (err) {
    $('#modalBody').innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
  }
}

function downloadAll() {
  const p = state.preview;
  if (!p?.bundles) return;
  for (const [side, files] of Object.entries(p.bundles)) {
    for (const [name, content] of Object.entries(files)) {
      const blob = new Blob([content], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${side}-${name.replace(/\//g, '_')}`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }
  toast('فایل‌ها دانلود شدند', 'ok');
}

// ============================================================ new tunnel
function pageNewTunnel() {
  const cats = [...new Set(state.templates.map((t) => t.category))];
  return `
  <div class="page-head">
    <h2>تونل جدید</h2>
    <span class="desc">یک سناریو از مستندات واتروال انتخاب کنید</span>
  </div>
  <div class="card">
    <h3>۱. انتخاب سناریو</h3>
    ${cats
      .map((c) => {
        const label = state.templates.find((t) => t.category === c)?.categoryFa || c;
        return `<h4 style="margin:16px 0 10px;font-size:12px;color:var(--accent)">${esc(label)}</h4>
          <div class="tpl-grid">${state.templates
            .filter((t) => t.category === c)
            .map(
              (t) => `<div class="tpl" data-tpl="${t.id}">
                <div class="ic">${t.icon}</div>
                <h4>${esc(t.titleFa)}</h4>
                <div class="en">${esc(t.title)}</div>
                <p>${esc(t.summaryFa)}</p>
                <div class="tags">
                  ${t.minVersion ? `<span class="badge" title="این سناریو به این نسخه واتروال نیاز دارد">نیازمند ${esc(t.minVersion)}</span>` : ''}
                  ${(t.tags || []).slice(0, 4).map((tag) => `<span class="badge mute">${esc(tag)}</span>`).join('')}
                </div>
              </div>`,
            )
            .join('')}</div>`;
      })
      .join('')}
  </div>
  ${state.selectedTemplate ? templateFormHtml(state.selectedTemplate) : '<div class="card"><div class="empty"><div class="ic">⬅️</div>از فهرست بالا یک سناریو انتخاب کنید.</div></div>'}`;
}

/** `targetServers.foreign` is a single id for ordinary templates and an array
 *  for reverse tunnels; the UI wants a list either way. */
function foreignList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

/** Human label for a server role / bundle side. */
function roleLabel(role) {
  if (role === 'iran') return 'ایران';
  if (role === 'relay') return 'رله';
  return 'خارج';
}

function sideLabel(side) {
  if (side === 'iran') return '🇮🇷 ایران';
  if (side === 'relay') return '🔀 رله';
  return '🌍 خارج';
}

/**
 * Ordered exit-server picker (templates marked `multiExit`).
 *
 * The order is stored in the tunnel's `targetServers.foreign` array. Two
 * tunnels may intentionally contain the same servers in opposite orders, so
 * this list is never re-sorted by the global server order — the operator moves
 * rows with ↑/↓ and that exact order is what the builder receives.
 */
function foreignPickerHtml(prefix, servers, selected) {
  if (!servers.length) {
    return '<div class="empty" style="padding:14px"><span class="small muted">سرور خارجی ثبت نشده است — از صفحهٔ «سرورها» اضافه کنید.</span></div>';
  }
  const byId = new Map(servers.map((s) => [s.id, s]));
  const chosen = foreignList(selected).filter((id) => byId.has(id));
  // A stored id that is no longer registered is dropped rather than rendered
  // as an empty row the operator cannot remove.
  const remaining = servers.filter((s) => !chosen.includes(s.id));
  return `<div class="pick-order" id="${prefix}_foreign_list" data-foreign-order>
    <div class="pick-chosen" data-chosen>
      ${
        chosen.length
          ? chosen.map((id, i) => pickRowHtml(byId.get(id), i)).join('')
          : '<div class="empty" style="padding:10px"><span class="small muted">هنوز سروری اضافه نشده — از منوی پایین اضافه کنید.</span></div>'
      }
    </div>
    <div class="pick-add">
      <select data-add-select ${remaining.length ? '' : 'disabled'}>
        ${
          remaining.length
            ? remaining.map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.host)}</option>`).join('')
            : '<option value="">— همه اضافه شده‌اند —</option>'
        }
      </select>
      <button type="button" class="sm" data-add ${remaining.length ? '' : 'disabled'}>افزودن</button>
    </div>
  </div>
  <span class="hint">ترتیب از بالا به پایین ذخیره می‌شود؛ سرور اول مسیر اصلی است. با ↑ و ↓ هر تونل را مستقل مرتب کنید.</span>`;
}

function pickRowHtml(server, index) {
  if (!server) return '';
  return `<div class="pick-row" data-id="${server.id}">
    <span class="ord">${index + 1}</span>
    <span class="pick-name">${esc(server.name)}</span>
    <span class="mono small muted">${esc(server.host)}</span>
    <span class="spacer"></span>
    <button type="button" class="sm" data-move="up" title="بالا">↑</button>
    <button type="button" class="sm" data-move="down" title="پایین">↓</button>
    <button type="button" class="sm danger" data-remove title="حذف">✕</button>
  </div>`;
}

/** Renumber rows and rebuild the "add" menu after any change. */
function refreshForeignPicker(box) {
  const rows = $$('.pick-row', box);
  rows.forEach((row, i) => {
    const ord = $('.ord', row);
    if (ord) ord.textContent = String(i + 1);
  });
  const chosenBox = $('[data-chosen]', box);
  if (chosenBox && !rows.length && !$('.empty', chosenBox)) {
    chosenBox.innerHTML =
      '<div class="empty" style="padding:10px"><span class="small muted">هنوز سروری اضافه نشده — از منوی پایین اضافه کنید.</span></div>';
  }
  const chosen = new Set(rows.map((row) => row.dataset.id));
  const remaining = state.servers.filter((s) => s.role === 'foreign' && !chosen.has(s.id));
  const select = $('[data-add-select]', box);
  if (select) {
    select.innerHTML = remaining.length
      ? remaining.map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.host)}</option>`).join('')
      : '<option value="">— همه اضافه شده‌اند —</option>';
    select.disabled = !remaining.length;
  }
  const add = $('[data-add]', box);
  if (add) add.disabled = !remaining.length;
}

function wireForeignPickers() {
  $$('[data-foreign-order]').forEach((box) => {
    box.onclick = (ev) => {
      const chosen = $('[data-chosen]', box);
      const button = ev.target.closest('button');
      if (!button || !chosen) return;
      const row = button.closest('.pick-row');
      if (button.matches('[data-add]')) {
        const select = $('[data-add-select]', box);
        const id = select?.value;
        const server = state.servers.find((s) => s.id === id);
        if (!server) return;
        $('.empty', chosen)?.remove();
        chosen.insertAdjacentHTML('beforeend', pickRowHtml(server, $$('.pick-row', box).length));
        refreshForeignPicker(box);
        return;
      }
      if (!row) return;
      if (button.matches('[data-remove]')) {
        row.remove();
      } else if (button.dataset.move === 'up') {
        const prev = row.previousElementSibling;
        if (prev?.classList.contains('pick-row')) chosen.insertBefore(row, prev);
      } else if (button.dataset.move === 'down') {
        const next = row.nextElementSibling;
        if (next?.classList.contains('pick-row')) chosen.insertBefore(next, row);
      }
      refreshForeignPicker(box);
    };
  });
}

/** Target selection currently visible in the create (`nt`) or edit (`et`) form. */
function readTargets(prefix) {
  const iran = $(`#${prefix}_iran`)?.value || null;
  const relay = $(`#${prefix}_relay`)?.value || null;
  const list = $(`#${prefix}_foreign_list`);
  const targets = { iran };
  if (relay) targets.relay = relay;
  if (list) targets.foreign = $$('.pick-row[data-id]', list).map((row) => row.dataset.id);
  else targets.foreign = $(`#${prefix}_foreign`)?.value || null;
  return targets;
}

function templateFormHtml(tpl) {
  const iran = state.servers.filter((s) => s.role === 'iran');
  const foreign = state.servers.filter((s) => s.role === 'foreign');
  const relay = state.servers.filter((s) => s.role === 'relay');
  const hasRelay = (tpl.sides || []).includes('relay');
  const groups = {};
  for (const f of tpl.fields) {
    const g = f.group || 'general';
    groups[g] = groups[g] || [];
    groups[g].push(f);
  }

  return `
  <div class="card">
    <h3>۲. پیکربندی — ${esc(tpl.titleFa)}</h3>
    <div class="chain">${esc(tpl.summary)}</div>
    <p class="small muted mt">${esc(tpl.summaryFa)}</p>
    ${
      tpl.docs ? `<p class="small mt"><a href="${tpl.docs}" target="_blank" style="color:var(--accent)">مستند همین سناریو در سایت رسمی ↗</a></p>` : ''
    }

    <hr class="sep">
    <div class="grid c2">
      <label class="f"><span class="lbl">نام تونل <span class="req">*</span></span>
        <input type="text" id="nt_name" value=""></label>
      <label class="f"><span class="lbl">سرور ایران</span>
        <select id="nt_iran">${iran.length ? iran.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') : '<option value="">— ثبت نشده —</option>'}</select></label>
    </div>
    ${
      hasRelay
        ? `<label class="f"><span class="lbl">سرور رله <span class="badge ok">میانی</span></span>
        <select id="nt_relay">${relay.length ? relay.map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.host)})</option>`).join('') : '<option value="">— ثبت نشده —</option>'}</select>
        <span class="hint">ترافیک کاربران از ایران به این سرور و از آن به سرور خارج می‌رود؛ IP سرور خارج هیچ‌وقت به ایران نمی‌رسد.</span></label>`
        : ''
    }
    ${
      tpl.multiExit
        ? `<label class="f"><span class="lbl">سرورهای خارج <span class="badge ok">چند-سروری</span></span>${foreignPickerHtml('nt', foreign, foreign.length ? [foreign[0].id] : [])}</label>`
        : tpl.sides?.includes('foreign') === false
          ? ''
          : `<label class="f"><span class="lbl">سرور خارج</span>
        <select id="nt_foreign">${foreign.length ? foreign.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') : '<option value="">— ثبت نشده —</option>'}</select></label>`
    }
    <label class="f"><span class="lbl">توضیحات</span><input type="text" id="nt_notes" placeholder="اختیاری"></label>

    ${Object.entries(groups)
      .map(
        ([g, fields]) => `<fieldset class="group">
        <legend>${esc(groupLabel(g))}</legend>
        ${fields.map((f) => fieldHtml(f)).join('')}
      </fieldset>`,
      )
      .join('')}

    <div class="row">
      <button class="primary" id="createTunnel">ساخت تونل</button>
      <button id="cancelTemplate">انصراف</button>
    </div>
  </div>`;
}

function groupLabel(g) {
  return (
    {
      entry: 'نقطه ورود',
      listen: 'شنود',
      destination: 'مقصد',
      crypto: 'رمزنگاری',
      tls: 'TLS',
      reality: 'Reality',
      mux: 'Mux',
      vless: 'VLESS',
      trojan: 'Trojan',
      http: 'HTTP / WebSocket',
      cdn: 'CDN',
      core: 'تنظیمات core.json',
      advanced: 'پیشرفته',
      wg: 'WireGuard',
      tun: 'اینترفیس TUN',
      transport: 'انتقال',
      dns: 'DNS',
      reverse: 'لینک معکوس',
      relay: 'رله',
      service: 'سرویس محلی مقصد',
      routes: 'مسیریابی',
      auth: 'احراز هویت',
      users: 'کاربران',
      limits: 'محدودیت‌ها',
      test: 'تنظیمات تست',
      upstream: 'پروکسی بالادست',
    }[g] || g
  );
}

function fieldHtml(f, value) {
  const id = `nf_${f.key}`;
  const req = f.required ? '<span class="req">*</span>' : '';
  const hint = f.help ? `<span class="hint">${esc(f.help)}</span>` : '';
  // The create form passes nothing (defaults apply); the edit form passes the
  // stored option so every field opens with the value it is running with.
  const val = value === undefined ? f.default : value;
  let input = '';

  switch (f.type) {
    case 'number':
      input = `<input type="number" id="${id}" data-key="${f.key}" data-type="number" value="${esc(val ?? '')}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}>`;
      break;
    case 'password': {
      // An `auto:` default is a request for a generated secret, not text to
      // show. Empty means "leave this alone": on create the server resolves the
      // auto default, on edit the old value goes back unchanged.
      const shown = typeof val === 'string' && val.startsWith('auto:') ? '' : String(val ?? '');
      const placeholder = String(f.default || '').startsWith('auto:')
        ? `خودکار: ${String(f.default).slice(5)}`
        : 'مقدار';
      input = `<div class="row" style="gap:6px"><input type="password" id="${id}" data-key="${f.key}" data-type="text" value="${esc(shown)}" placeholder="${esc(placeholder)}">
        <button class="sm" data-gen="${f.key}">🎲</button></div>`;
      break;
    }
    case 'boolean':
      // The wrapping label already prints f.label; repeating it inside the
      // switch rendered every boolean twice.
      input = `<label class="switch"><input type="checkbox" id="${id}" data-key="${f.key}" data-type="boolean" ${val ? 'checked' : ''}><span class="track"></span></label>`;
      break;
    case 'select':
      input = `<select id="${id}" data-key="${f.key}" data-type="text">${(f.options || [])
        .map((o) => `<option value="${esc(o)}" ${String(o) === String(val) ? 'selected' : ''}>${esc(o)}</option>`)
        .join('')}</select>`;
      break;
    case 'list':
      input = `<div class="list-input" data-list="${f.key}">
          <input type="text" data-key="${f.key}" data-type="list" placeholder="${esc(f.placeholder || 'مقدار، با کاما جدا کنید')}">
          <button class="sm" data-add="${f.key}">+</button>
        </div><div class="chips" id="chips_${f.key}"></div>`;
      break;
    case 'csv':
      input = `<input type="text" id="${id}" data-key="${f.key}" data-type="csv" value="${esc((Array.isArray(val) ? val : []).join(', '))}">`;
      break;
    case 'keyvalue':
      input = `<div data-kv="${f.key}"></div><button class="sm mt" data-kvadd="${f.key}">+ کاربر</button>`;
      break;
    case 'users':
      input = `<div data-users="${f.key}"></div><button class="sm mt" data-useradd="${f.key}">+ کاربر</button>`;
      break;
    default:
      input = `<input type="text" id="${id}" data-key="${f.key}" data-type="text" value="${esc(val ?? '')}">`;
  }
  return `<label class="f" data-field="${f.key}" ${f.when ? `data-when='${esc(JSON.stringify(f.when))}'` : ''}>
      <span class="lbl">${esc(f.label)} ${req}</span>${input}${hint}
    </label>`;
}

function collectForm(tpl, { keepEmpty = false, fallback = null } = {}) {
  const options = {};
  for (const f of tpl.fields) {
    if (f.type === 'boolean') {
      const el = $(`[data-key="${f.key}"]`);
      if (el) options[f.key] = el.checked;
      continue;
    }
    const el = $(`[data-key="${f.key}"]`);
    if (!el) continue;
    const raw = el.value;
    if (f.type === 'number') {
      if (raw === '') {
        // Cleared on the edit form: '' makes the server fall back to the
        // template default instead of silently keeping the stale value.
        if (keepEmpty) options[f.key] = '';
        continue;
      }
      options[f.key] = Number(raw);
    } else if (f.type === 'list') {
      options[f.key] = String(raw || '')
        .split(/[\s,]+/)
        .filter(Boolean);
    } else if (f.type === 'csv') {
      options[f.key] = String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (f.type === 'password') {
      // An empty box means "leave the current secret alone". On the edit form
      // the old value has to go back in, otherwise the server resolves the
      // field's `auto:` default into a fresh secret and the live tunnel breaks.
      if (raw !== '') options[f.key] = raw;
      else if (keepEmpty && fallback && fallback[f.key] !== undefined) options[f.key] = fallback[f.key];
    } else if (keepEmpty) {
      // Editing: a field the user cleared stays cleared (the create form lets
      // empty mean "use the template default").
      options[f.key] = raw;
    } else if (raw !== '') {
      options[f.key] = raw;
    }
  }
  // repeat-row widgets
  for (const el of $$('[data-kv]')) {
    options[el.dataset.kv] = readRows(el);
  }
  for (const el of $$('[data-users]')) {
    options[el.dataset.users] = readUserRows(el);
  }
  return options;
}

function readRows(container) {
  return $$('.kv-row', container).map((row) => {
    const o = {};
    $$('[data-col]', row).forEach((i) => {
      o[i.dataset.col] = i.type === 'number' ? (i.value === '' ? undefined : Number(i.value)) : i.value;
    });
    return o;
  });
}

function readUserRows(container) {
  return $$('.user-row', container)
    .map((row) => {
      const o = {};
      $$('[data-col]', row).forEach((i) => {
        o[i.dataset.col] = i.type === 'checkbox' ? i.checked : i.value;
      });
      return o;
    })
    .filter((u) => u.username);
}

async function createTunnel(tpl) {
  const name = $('#nt_name').value.trim();
  if (!name) {
    toast('نام تونل را وارد کنید', 'err');
    return;
  }
  const targets = readTargets('nt');
  if ($('#nt_foreign_list') && !targets.foreign.length) {
    toast('حداقل یک سرور خارج انتخاب کنید', 'err');
    return;
  }
  if ($('#nt_relay') && !targets.relay) {
    toast('یک سرور رله انتخاب کنید (یا ابتدا آن را در صفحهٔ سرورها ثبت کنید)', 'err');
    return;
  }
  const options = collectForm(tpl);
  try {
    const r = await api('/api/tunnels', {
      method: 'POST',
      body: {
        name,
        template: tpl.id,
        notes: $('#nt_notes').value.trim(),
        options,
        targetServers: targets,
      },
    });
    state.tunnels.push(r.tunnel);
    toast('تونل ساخته شد', 'ok');
    state.selectedTemplate = null;
    openTunnel(r.tunnel.id);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// =================================================================== test
function pageTest() {
  return `
  <div class="page-head">
    <h2>تست اتصال</h2>
    <span class="desc">تست پورت، تست سرتاسری از داخل تونل، و سنجش سرعت</span>
  </div>

  <div class="grid c2">
    <div class="card">
      <h3>🔌 تست پورت TCP</h3>
      <div class="grid c2">
        <label class="f"><span class="lbl">آدرس</span><input type="text" id="tcpHost" placeholder="198.51.100.7"></label>
        <label class="f"><span class="lbl">پورت</span><input type="number" id="tcpPort" value="443"></label>
      </div>
      <button class="primary" id="runTcp">اجرا</button>
      <div id="tcpOut" class="mt"></div>
    </div>

    <div class="card">
      <h3>🧭 تست سرتاسری (SOCKS5 → اینترنت)</h3>
      <p class="small muted">اگر SOCKS5 روی سرور ایران دارید، این تست ثابت می‌کند که کل زنجیره تونل واقعاً ترافیک عبور می‌دهد.</p>
      <div class="grid c2">
        <label class="f"><span class="lbl">آدرس SOCKS5</span><input type="text" id="socksHost" placeholder="10.0.0.1"></label>
        <label class="f"><span class="lbl">پورت</span><input type="number" id="socksPort" value="1080"></label>
      </div>
      <button class="primary" id="runSocks">اجرا</button>
      <div id="socksOut" class="mt"></div>
    </div>

    <div class="card">
      <h3>📶 تست سرعت</h3>
      <div class="grid c2">
        <label class="f"><span class="lbl">آدرس SOCKS5</span><input type="text" id="spHost"></label>
        <label class="f"><span class="lbl">پورت</span><input type="number" id="spPort" value="1080"></label>
      </div>
      <label class="f"><span class="lbl">حجم دانلود (مگابایت)</span><input type="number" id="spBytes" value="8"></label>
      <button class="primary" id="runSpeed">اجرا</button>
      <div id="speedOut" class="mt"></div>
    </div>

    <div class="card">
      <h3>📡 سایر ابزارها</h3>
      <div class="grid c2">
        <label class="f"><span class="lbl">پینگ (ICMP)</span><input type="text" id="pingHost" placeholder="198.51.100.7"></label>
        <label class="f"><span class="lbl">رَس‌تریس</span><input type="text" id="traceHost" placeholder="198.51.100.7"></label>
      </div>
      <div class="row">
        <button id="runPing">پینگ</button>
        <button id="runTrace">ردیابی مسیر</button>
        <button id="runResolve">Resolve DNS</button>
        <button id="runUdp">تست UDP</button>
      </div>
      <div id="miscOut" class="mt"></div>
    </div>
  </div>`;
}

function outBox(id, data) {
  $(id).innerHTML = `<pre class="code">${highlight(data)}</pre>`;
}

// ===================================================================== api
function pageApi() {
  const token = state.token;
  const base = location.origin;
  return `
  <div class="page-head">
    <h2>API و ایجنت</h2>
    <span class="desc">کنترل پنل با API یا از راه ایجنت روی سرورها</span>
  </div>

  <div class="card">
    <h3>🔑 توکن پنل</h3>
    <div class="row">
      <input type="text" class="mono" value="${esc(token)}" readonly style="flex:1;min-width:260px">
      <button onclick="copy(window.__wwToken,'توکن')">کپی</button>
    </div>
    <p class="small muted mt">همه درخواست‌ها با هدر <span class="mono">Authorization: Bearer &lt;token&gt;</span> یا <span class="mono">?token=…</span> احراز می‌شوند.</p>
  </div>

  <div class="card">
    <h3>📡 نقاط پایانی اصلی</h3>
    <table>
      <thead><tr><th>متد</th><th>مسیر</th><th>توضیح</th></tr></thead>
      <tbody>
        <tr><td class="mono">GET</td><td class="ltr">/api/bootstrap</td><td>وضعیت اولیه: سرورها، تونل‌ها و قالب‌ها</td></tr>
        <tr><td class="mono">GET</td><td class="ltr">/api/tunnels</td><td>فهرست تونل‌ها</td></tr>
        <tr><td class="mono">POST</td><td class="ltr">/api/tunnels</td><td>ساخت تونل از روی یک قالب</td></tr>
        <tr><td class="mono">POST</td><td class="ltr">/api/tunnels/:id/preview</td><td>تولید کانفیگ بدون اعمال</td></tr>
        <tr><td class="mono">POST</td><td class="ltr">/api/tunnels/:id/apply</td><td>نوشتن کانفیگ روی سرورها و ری‌استارت</td></tr>
        <tr><td class="mono">POST</td><td class="ltr">/api/tunnels/:id/regenerate</td><td>بازتولید رمزها و UUIDها</td></tr>
        <tr><td class="mono">GET/POST</td><td class="ltr">/api/tunnels/:id/users</td><td>مدیریت کاربران (قالب auth-users)</td></tr>
        <tr><td class="mono">POST</td><td class="ltr">/api/test/{tcp,socks,speed,ping,traceroute,udp,resolve}</td><td>تست‌های شبکه</td></tr>
        <tr><td class="mono">GET</td><td class="ltr">/api/events</td><td>رویدادهای زنده (SSE)</td></tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h3>🧩 نصب ایجنت روی سرور</h3>
    <p class="small muted">ایجنت روی هر دو سرور (ایران و خارج) اجرا می‌شود و کانفیگ را از پنل می‌گیرد. توکن هر سرور در جدول زیر است.</p>
    <table>
      <thead><tr><th>سرور</th><th>نقش</th><th>Agent Token</th><th></th></tr></thead>
      <tbody>
        ${
          state.servers.length
            ? state.servers
                .map(
                  (s) => `<tr>
            <td>${esc(s.name)}</td>
            <td><span class="badge ${s.role === 'iran' ? 'ok' : ''}">${roleLabel(s.role)}</span></td>
            <td class="ltr small">${esc(s.agentToken)}</td>
            <td><button class="sm" onclick="copy('${esc(s.agentToken)}','توکن')">کپی</button>
                <button class="sm" data-srv-conn="${s.id}">دستور نصب</button></td>
          </tr>`,
                )
                .join('')
            : '<tr><td colspan="4" class="muted small">سروری ثبت نشده است.</td></tr>'
        }
      </tbody>
    </table>
    <label class="f mt"><span class="lbl">نمونه: ساخت تونل با API</span>
      <textarea readonly style="min-height:150px">curl -X POST ${base}/api/tunnels \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "main-tunnel",
    "template": "vless-reality",
    "options": {
      "listenPort": 1080,
      "publicPort": 443,
      "realitySni": "www.microsoft.com",
      "camouflageHost": "www.microsoft.com"
    }
  }'</textarea></label>
  </div>`;
}

// =============================================================== afterRender
/**
 * Certificate page actions.
 *
 * A failed Let's Encrypt attempt in "auto" mode is not an error the user should
 * have to interpret: the panel already fell back to a self-signed certificate,
 * so the message says what happened and why rather than leaving the box empty.
 */
async function doIssueCert() {
  const out = document.getElementById('certOut');
  const domain = document.getElementById('certDomain').value.trim();
  const mode = document.getElementById('certMode').value;
  const serverId = document.getElementById('certServer').value;
  const email = document.getElementById('certEmail').value.trim();

  if (!domain) {
    out.innerHTML = '<div class="err-box">دامنه را وارد کنید.</div>';
    return;
  }
  out.innerHTML = '<div class="small muted">در حال صدور… این کار ممکن است تا یک دقیقه طول بکشد.</div>';

  try {
    const r = await api('/api/certs', { method: 'POST', body: { domain, mode, serverId, email } });
    if (!r.ok) {
      const reason = r.reason
        ? '<br><span class="small">علت فنی: <span class="mono">' + esc(r.reason) + '</span></span>'
        : '';
      out.innerHTML = '<div class="err-box">' + esc(r.error || 'صدور ناموفق بود') + reason + '</div>';
      return;
    }
    const c = r.cert;
    const note = c.fallbackNote ? '<br><span class="small muted">' + esc(c.fallbackNote) + '</span>' : '';
    out.innerHTML =
      '<div class="ok-box"><b>' + esc(c.domain) + '</b> — ' + esc(c.mode) +
      '<br>تا ' + esc(fmtDate(c.notAfter)) + ' (' + c.daysLeft + ' روز)' + note + '</div>';
    await loadCerts();
    render();
  } catch (err) {
    out.innerHTML = '<div class="err-box">' + esc(err.message) + '</div>';
  }
}

async function fillCertServerPicker() {
  const sel = document.getElementById('certServer');
  if (!sel) return;
  const servers = state.servers || [];
  sel.innerHTML = servers.length
    ? servers
        .map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name) + ' (' + esc(roleLabel(x.role)) + ')</option>')
        .join('')
    : '<option value="">سروری ثبت نشده</option>';
  // Default to the exit box, which is where most templates need a certificate.
  const foreign = servers.find((x) => x.role === 'foreign');
  if (foreign) sel.value = foreign.id;
}

/**
 * Wire the certificate page actions.
 *
 * Called from afterRender(), where the page DOM exists: attaching these when
 * the script first loads would find no elements, because the page is rendered
 * on demand.
 */
function wireCertActions() {
  const btn = document.getElementById('certIssueNow');
  if (btn && btn.dataset.wired !== '1') {
    btn.dataset.wired = '1';
    btn.addEventListener('click', doIssueCert);
  }
  const focus = document.getElementById('certIssue');
  if (focus && focus.dataset.wired !== '1') {
    focus.dataset.wired = '1';
    focus.addEventListener('click', () => document.getElementById('certDomain')?.focus());
  }
  fillCertServerPicker();
}

function afterRender() {
  wireCertActions();
  wireOutbound();
  wireBackup();
  wireForeignPickers();
  // Reload certificate state only when the page is *opened*, never on every
  // render: re-rendering from here would recurse forever.
  if (state.page === 'certs' && state.lastCertPage !== state.certsPageToken) {
    state.lastCertPage = state.certsPageToken;
    loadCerts().then(render);
  }
  // dashboard
  $('#quickNew')?.addEventListener('click', () => go('new'));
  $('#dashServers')?.addEventListener('click', () => go('servers'));
  $('#dashTunnels')?.addEventListener('click', () => go('tunnels'));
  $('#dashOutbound')?.addEventListener('click', () => go('outbound'));
  $('#dashLinksCheck')?.addEventListener('click', () => loadLinks(true));
  if ($('#dashLog')) loadEvents();
  // Probing costs a round trip through the CDN, so it runs once per visit to
  // the dashboard rather than on every render the event stream triggers.
  if (state.page === 'dashboard' && !state.linksProbed) {
    state.linksProbed = true;
    loadLinks(false);
  }

  // servers
  $('#addServer')?.addEventListener('click', () => {
    openModal('افزودن سرور', serverForm(), [
      { text: 'انصراف', class: '', onClick: closeModal },
      { text: 'ذخیره', class: 'primary', onClick: () => saveServer(null) },
    ]);
  });
  $$('[data-srv-edit]').forEach((b) => {
    b.onclick = () => {
      const s = state.servers.find((x) => x.id === b.dataset.srvEdit);
      openModal('ویرایش سرور', serverForm(s), [
        { text: 'انصراف', class: '', onClick: closeModal },
        { text: 'ذخیره', class: 'primary', onClick: () => saveServer(s) },
      ]);
    };
  });
  $$('[data-srv-probe]').forEach((b) => {
    b.onclick = () => probeServer(b.dataset.srvProbe);
  });
  // ---- core upgrade --------------------------------------------------------
  const upgradeVersion = () => $('#upgradeVersion')?.value || state.versions?.current;

  const loadUpgradePlan = async () => {
    state.upgradeBusy = true;
    state.upgradeMsg = null;
    render();
    try {
      const [releases, plan] = await Promise.all([
        api('/api/upgrade/releases'),
        api(`/api/upgrade/plan?version=${encodeURIComponent(upgradeVersion())}`),
      ]);
      state.upgrade = { releases: releases.releases || [], plan };
      state.upgradeBusy = false;
      render();
    } catch (err) {
      state.upgradeBusy = false;
      state.upgradeMsg = { ok: false, text: err.message };
      render();
    }
  };

  const runUpgrade = async (serverIds, allowPartial) => {
    state.upgradeBusy = true;
    state.upgradeMsg = null;
    render();
    try {
      const res = await api('/api/upgrade/apply', {
        method: 'POST',
        body: { version: upgradeVersion(), serverIds, allowPartial, dryRun: false, restart: true },
      });
      const done = (res.results || []).filter((r) => r.ok);
      const failed = (res.failed || []).length;
      const lines = (res.results || [])
        .map((r) =>
          r.skipped
            ? `⊘ ${r.name}: ${r.reason}`
            : r.ok
              ? `✓ ${r.name}${r.installed ? ` — ${r.installed.length} نصب به‌روز شد` : ''}`
              : `✗ ${r.name}: ${r.error || 'ناموفق'}`,
        )
        .join('<br>');
      state.upgradeMsg = {
        ok: !failed,
        text: `ارتقا به ${res.target}: ${done.length} سرور موفق، ${failed} ناموفق.<br>${lines}`,
      };
      state.upgradeBusy = false;
      // The servers report their new version through the agent, so the table
      // is re-read rather than patched in the browser.
      await loadUpgradePlan();
    } catch (err) {
      state.upgradeBusy = false;
      state.upgradeMsg = { ok: false, text: err.message };
      render();
    }
  };

  $('#upgradePlanBtn')?.addEventListener('click', loadUpgradePlan);
  $('#upgradeApplyBtn')?.addEventListener('click', () => runUpgrade(null, false));
  $('#upgradePartialBtn')?.addEventListener('click', () => {
    const ids = state.upgrade?.plan?.servers?.filter((r) => r.ok && !r.nothingToDo).map((r) => r.id) || [];
    runUpgrade(ids, true);
  });
  $$('[data-upgrade-one]').forEach((b) => {
    b.onclick = () => runUpgrade([b.dataset.upgradeOne], true);
  });
  $$('[data-srv-logs]').forEach((b) => {
    b.onclick = () => showServerLogs(b.dataset.srvLogs);
  });
  const moveServer = async (id, direction) => {
    try {
      const r = await api(`/api/servers/${id}/move`, { method: 'POST', body: { direction } });
      state.servers = r.servers;
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $$('[data-srv-up]').forEach((b) => {
    b.onclick = () => moveServer(b.dataset.srvUp, 'up');
  });
  $$('[data-srv-down]').forEach((b) => {
    b.onclick = () => moveServer(b.dataset.srvDown, 'down');
  });
  $$('[data-srv-conn]').forEach((b) => {
    b.onclick = () => showAgentSetup(state.servers.find((x) => x.id === b.dataset.srvConn));
  });
  $$('[data-srv-del]').forEach((b) => {
    b.onclick = async () => {
      const s = state.servers.find((x) => x.id === b.dataset.srvDel);
      if (!confirm(`سرور «${s.name}» حذف شود؟`)) return;
      await api(`/api/servers/${s.id}`, { method: 'DELETE' });
      state.servers = state.servers.filter((x) => x.id !== s.id);
      toast('حذف شد', 'ok');
      render();
    };
  });

  // tunnels list
  $('#newTunnel')?.addEventListener('click', () => go('new'));
  $$('[data-tn-open]').forEach((b) => {
    b.onclick = () => openTunnel(b.dataset.tnOpen);
  });
  $$('[data-tn-preview]').forEach((b) => {
    b.onclick = async () => {
      openTunnel(b.dataset.tnPreview);
      await doPreview();
    };
  });
  $$('[data-tn-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('این تونل حذف شود؟ فایل کانفیگ و سرویسش روی سرورها هم پاک/متوقف می‌شود.')) return;
      const r = await api(`/api/tunnels/${b.dataset.tnDel}`, { method: 'DELETE' });
      state.tunnels = state.tunnels.filter((x) => x.id !== b.dataset.tnDel);
      const failed = (r.cleanup || []).filter((row) => !row.ok);
      if (failed.length) {
        toast(`حذف شد، ولی پاک‌سازی روی ${failed.map((f) => f.server).join('، ')} انجام نشد`, 'err');
      } else {
        toast('حذف شد و فایل/سرویس روی سرورها پاک شد', 'ok');
      }
      render();
    };
  });

  // new tunnel
  $$('[data-tpl]').forEach((el) => {
    el.onclick = () => {
      $$('[data-tpl]').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      state.selectedTemplate = state.templates.find((t) => t.id === el.dataset.tpl);
      const nameInput = $('#nt_name');
      if (nameInput && !nameInput.value) nameInput.value = el.dataset.tpl;
      render();
      $('#nt_name')?.focus();
    };
  });
  $('#cancelTemplate')?.addEventListener('click', () => {
    state.selectedTemplate = null;
    render();
  });
  $('#createTunnel')?.addEventListener('click', () => createTunnel(state.selectedTemplate));
  if (state.selectedTemplate) initDynamicFields(state.selectedTemplate);

  // tunnel detail
  if (state.page === 'edit' && state.draft) {
    initDynamicFields(state.templates.find((x) => x.id === state.draft.template), state.draft.options);
  }
  $('#editBack')?.addEventListener('click', () => go('tunnels'));
  $('#doPreview')?.addEventListener('click', doPreview);
  $('#editSave')?.addEventListener('click', async () => {
    if (await saveTunnel()) render();
  });
  $('#editApply')?.addEventListener('click', () => doApply(false));
  $('#doDry')?.addEventListener('click', () => doApply(true));
  $('#doLogs')?.addEventListener('click', showLogs);
  $('#doProtocolScan')?.addEventListener('click', runProtocolScan);
  $('#doRegen')?.addEventListener('click', async () => {
    if (!confirm('همه رمزها و UUIDهای تولیدشده بازتولید شوند؟')) return;
    const r = await api(`/api/tunnels/${state.draft.id}/regenerate`, { method: 'POST' });
    state.draft.options = r.tunnel.options;
    state.tunnels = state.tunnels.map((x) => (x.id === r.tunnel.id ? r.tunnel : x));
    toast('رمزها بازتولید شد', 'ok');
    await doPreview();
  });
  $('#doClient')?.addEventListener('click', async () => {
    const r = await api(`/api/tunnels/${state.draft.id}/client`);
    if (!r.available) return toast(r.reason, 'err');
    openModal(
      'اطلاعات اتصال کلاینت',
      `${clientHtml({ client: r })}`,
      [{ text: 'بستن', class: 'primary', onClick: closeModal }],
    );
  });
  $('#doRestart')?.addEventListener('click', async () => {
    const r = await api(`/api/tunnels/${state.draft.id}/service`, { method: 'POST', body: { action: 'restart' } });
    const lines = Object.entries(r.results)
      .map(([k, v]) => `<div class="${v.ok ? 'ok-box' : 'err-box'}">${k}: ${esc(v.output || v.error || '')}</div>`)
      .join('');
    openModal('ری‌استارت سرویس', lines, [{ text: 'بستن', class: 'primary', onClick: closeModal }]);
  });
  $$('[data-side]').forEach((el) => {
    el.onclick = () => {
      state.activePreviewTab = el.dataset.side;
      state.previewFile = null;
      render();
    };
  });
  $$('[data-file]').forEach((el) => {
    el.onclick = () => {
      state.previewFile = el.dataset.file;
      render();
    };
  });
  $('#copyFile')?.addEventListener('click', () => {
    const side = state.activePreviewTab;
    const p = state.preview;
    if (!p?.bundles?.[side]) return;
    const files = p.bundles[side];
    const name = state.previewFile && files[state.previewFile] ? state.previewFile : Object.keys(files)[0];
    copy(files[name], name);
  });
  $('#downloadAll')?.addEventListener('click', downloadAll);
  $$('[data-copy]').forEach((b) => {
    b.onclick = () => copy(b.dataset.copy, 'لینک');
  });
  $$('[data-user-del]').forEach((b) => {
    b.onclick = async () => {
      const users = [...(state.draft.options.users || [])];
      users.splice(Number(b.dataset.userDel), 1);
      state.draft.options.users = users;
      await saveTunnel(true);
      render();
    };
  });
  $('#addUser')?.addEventListener('click', async () => {
    const username = $('#newUserName').value.trim();
    if (!username) return;
    const users = [...(state.draft.options.users || [])];
    users.push({
      username,
      password: $('#newUserPass').value.trim() || Math.random().toString(36).slice(2) + Date.now().toString(36),
      totalLimitGb: Number($('#newUserLimit').value) || undefined,
      enabled: true,
    });
    state.draft.options.users = users;
    await saveTunnel(true);
    toast('کاربر اضافه شد — برای اعمال، «ذخیره و اعمال» را بزنید', 'ok');
    render();
  });

  // test page
  $('#runTcp')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/test/tcp', {
        method: 'POST',
        body: { host: $('#tcpHost').value.trim(), port: Number($('#tcpPort').value) },
      });
      outBox('#tcpOut', r);
    } catch (err) {
      outBox('#tcpOut', { error: err.message });
    }
  });
  $('#runSocks')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/test/socks', {
        method: 'POST',
        body: { host: $('#socksHost').value.trim(), port: Number($('#socksPort').value) },
      });
      outBox('#socksOut', r);
    } catch (err) {
      outBox('#socksOut', { error: err.message });
    }
  });
  $('#runSpeed')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/test/speed', {
        method: 'POST',
        body: {
          host: $('#spHost').value.trim(),
          port: Number($('#spPort').value),
          bytes: Number($('#spBytes').value) * 1024 * 1024,
          timeout: 60000,
        },
      });
      outBox('#speedOut', r);
    } catch (err) {
      outBox('#speedOut', { error: err.message });
    }
  });
  const misc = (kind, field) => {
    $(`#run${kind}`)?.addEventListener('click', async () => {
      const host = $(field).value.trim();
      if (!host) return;
      try {
        const r = await api(`/api/test/${kind.toLowerCase()}`, { method: 'POST', body: { host } });
        outBox('#miscOut', r);
      } catch (err) {
        outBox('#miscOut', { error: err.message });
      }
    });
  };
  misc('Ping', '#pingHost');
  misc('Trace', '#traceHost');
  misc('Resolve', '#traceHost');
  $('#runUdp')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/test/udp', { method: 'POST', body: { server: '1.1.1.1' } });
      outBox('#miscOut', r);
    } catch (err) {
      outBox('#miscOut', { error: err.message });
    }
  });
}

// --------------------------------------------------------- dynamic fields
function initDynamicFields(tpl, values) {
  if (!tpl) return;
  // `values` is the option map of a saved tunnel (edit page); without it the
  // template defaults seed the create form exactly as before.
  const val = (f) => (values && values[f.key] !== undefined ? values[f.key] : f.default);
  // chips for list fields
  for (const f of tpl.fields.filter((x) => x.type === 'list')) {
    renderChips(f.key, [].concat(val(f) || []));
  }
  // keyvalue rows
  for (const f of tpl.fields.filter((x) => x.type === 'keyvalue')) {
    const host = $(`[data-kv="${f.key}"]`);
    [].concat(val(f) || []).forEach((row) => addKvRow(host, row));
  }
  // user rows
  for (const f of tpl.fields.filter((x) => x.type === 'users')) {
    const host = $(`[data-users="${f.key}"]`);
    [].concat(val(f) || []).forEach((row) => addUserRow(host, row));
  }
  // generate buttons
  $$('[data-gen]').forEach((b) => {
    b.onclick = () => {
      const el = $(`[data-key="${b.dataset.gen}"]`);
      if (el) el.value = Math.random().toString(36).slice(2) + Date.now().toString(36);
    };
  });
  // list add buttons
  $$('[data-add]').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.add;
      const el = $(`[data-key="${key}"]`);
      const values = String(el.value || '')
        .split(/[\s,]+/)
        .filter(Boolean);
      if (values[values.length - 1]) {
        renderChips(key, values);
        el.value = '';
      }
    };
    $(`[data-key="${b.dataset.add}"]`)?.addEventListener('change', (e) => {
      const values = String(e.target.value || '')
        .split(/[\s,]+/)
        .filter(Boolean);
      if (values.length) renderChips(b.dataset.add, values);
    });
  });
  // keyvalue add
  $$('[data-kvadd]').forEach((b) => {
    b.onclick = () => addKvRow($(`[data-kv="${b.dataset.kvadd}"]`), {});
  });
  // user add
  $$('[data-useradd]').forEach((b) => {
    b.onclick = () => addUserRow($(`[data-users="${b.dataset.useradd}"]`), {});
  });
  applyWhenConditions(tpl);
}

function renderChips(key, values) {
  const host = $(`#chips_${key}`);
  if (!host) return;
  host.innerHTML = values
    .map((v, i) => `<span class="chip">${esc(v)}<button data-chip="${i}">✕</button></span>`)
    .join('');
  const el = $(`[data-key="${key}"]`);
  el.value = values.join(', ');
  $$('#chips_' + key + ' [data-chip]').forEach((b) => {
    b.onclick = () => {
      values.splice(Number(b.dataset.chip), 1);
      renderChips(key, values);
    };
  });
}

function addKvRow(host, row) {
  if (!host) return;
  const div = document.createElement('div');
  div.className = 'kv-row row mb';
  div.innerHTML = `
    <input type="text" data-col="username" placeholder="username" value="${esc(row.username || '')}" style="flex:1;min-width:130px">
    <input type="text" data-col="password" placeholder="password" value="${esc(row.password || '')}" style="flex:1;min-width:130px">
    <button class="sm danger" data-rm>✕</button>`;
  div.querySelector('[data-rm]').onclick = () => div.remove();
  host.appendChild(div);
}

function addUserRow(host, row) {
  if (!host) return;
  const div = document.createElement('div');
  div.className = 'user-row row mb';
  div.innerHTML = `
    <input type="text" data-col="username" placeholder="نام کاربری" value="${esc(row.username || '')}" style="flex:1;min-width:120px">
    <input type="text" data-col="password" placeholder="رمز" value="${esc(row.password || '')}" style="flex:1;min-width:120px">
    <input type="number" data-col="deviceLimit" placeholder="سقف دستگاه" value="${row.deviceLimit ?? ''}" style="width:110px">
    <input type="number" data-col="totalLimitGb" placeholder="سقف GB" value="${row.totalLimitGb ?? ''}" style="width:100px">
    <input type="checkbox" data-col="enabled" ${row.enabled !== false ? 'checked' : ''} title="فعال">
    <button class="sm danger" data-rm>✕</button>`;
  div.querySelector('[data-rm]').onclick = () => div.remove();
  host.appendChild(div);
}

function applyWhenConditions(tpl) {
  const evaluate = () => {
    for (const f of tpl.fields) {
      if (!f.when) continue;
      const el = $(`[data-field="${f.key}"]`);
      if (!el) continue;
      const visible = Object.entries(f.when).every(([k, v]) => {
        const ctrl = $(`[data-key="${k}"]`);
        if (!ctrl) return true;
        const actual = ctrl.type === 'checkbox' ? ctrl.checked : ctrl.value;
        return String(actual) === String(v) || (v === '*' && actual);
      });
      el.style.display = visible ? '' : 'none';
    }
  };
  for (const f of tpl.fields.filter((x) => x.when)) {
    Object.keys(f.when).forEach((k) => {
      $(`[data-key="${k}"]`)?.addEventListener('change', evaluate);
    });
  }
  evaluate();
}

// -------------------------------------------------------------- event log
/**
 * Fetch the CDN link verdicts.
 *
 * `fresh` is the "check again" path: it re-probes even when the server still has
 * a recent cached answer. The busy flag is what the disabled button and the
 * "checking…" row read, so a double click cannot start two rounds.
 */
async function loadLinks(fresh = false) {
  if (state.linksBusy) return;
  state.linksBusy = true;
  state.linksError = null;
  if (state.page === 'dashboard') render();
  try {
    const r = await api(`/api/links${fresh ? '?fresh=1' : ''}`);
    state.links = r.links || [];
    state.linksCheckedAt = r.checkedAt || new Date().toISOString();
    if (r.outbound) state.outbound = r.outbound;
  } catch (err) {
    state.linksError = err.message;
  } finally {
    state.linksBusy = false;
    if (state.page === 'dashboard') render();
  }
}

async function loadEvents() {
  const host = $('#dashLog');
  if (!host) return;
  // The header is enough here. The query parameter is only tolerated on the
  // event stream because EventSource cannot send one, and carrying the token in
  // a URL is what puts it into logs and history in the first place.
  const res = await fetch('/api/events', {
    headers: { authorization: `Bearer ${state.token}` },
  });
  if (!res.ok) {
    host.textContent = 'دسترسی به رویدادها ممکن نشد.';
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const lines = [];
  host.innerHTML = '';
  const push = (text, cls) => {
    const div = document.createElement('div');
    div.textContent = text;
    if (cls) div.style.color = cls;
    host.appendChild(div);
    while (host.childElementCount > 300) host.firstChild.remove();
    host.scrollTop = host.scrollHeight;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const evName = (/(?:^|\n)event:\s*(\S+)/.exec(part) || [])[1] || '';
      try {
        const e = JSON.parse(dataLine.slice(5).trim());
        lines.push(e);
        // Stored log entries carry their own `at` and `type`. The live
        // broadcasts (server-status, servers, tunnels) carry neither, which
        // used to render as "Invalid Date  undefined  {…}" for every status
        // report in the feed — once per server every 15 seconds.
        const stamp = new Date(e.at || Date.now()).toLocaleTimeString('fa-IR');
        const name = e.type || evName || 'رویداد';
        const body = Array.isArray(e)
          ? `${e.length} مورد`
          : e.status && typeof e.status === 'object'
            ? `${String(e.serverId || '').slice(0, 8)} ${e.status.service || ''}`.trim()
            : JSON.stringify(e).slice(0, 160);
        push(`${stamp}  ${name}  ${body}`);
      } catch {
        /* ignore */
      }
    }
  }
}

window.__wwToken = state.token;
window.copy = copy;

// ------------------------------------------------------------------ start
// The reachability report lives inside a modal, so its buttons are created
// after afterRender() has already run. Delegating from the document means the
// handler works no matter when the markup appears, and no button can be missed
// by a wiring step that has to remember to call it.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-fix]');
  if (btn) doFirewallFix(btn);
});

(async function start() {
  if (!state.token) return;
  try {
    await loadAll();
    $('#login').style.display = 'none';
    $('#app').classList.add('ready');
    window.__wwToken = state.token;
    connectEvents();
    render();
  } catch {
    localStorage.removeItem('ww_token');
  }
})();
