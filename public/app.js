'use strict';

/* WaterWall Panel — front end (vanilla, no build step) */

const state = {
  token: localStorage.getItem('ww_token') || '',
  servers: [],
  tunnels: [],
  templates: [],
  versions: null,
  certs: null,
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
};

// ------------------------------------------------------------------ utils
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  for (const evt of ['servers', 'tunnels', 'log', 'server-status']) {
    eventSource.addEventListener(evt, async (e) => {
      try {
        const data = JSON.parse(e.data);
        if (evt === 'servers' && Array.isArray(data)) state.servers = data;
        if (evt === 'tunnels' && Array.isArray(data)) {
          state.tunnels = data;
          if (state.page === 'dashboard' || state.page === 'tunnels') render();
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
  }
  const fns = {
    dashboard: pageDashboard,
    servers: pageServers,
    tunnels: pageTunnels,
    new: pageNewTunnel,
    edit: pageEditTunnel,
    test: pageTest,
    api: pageApi,
    certs: pageCerts,
  };
  el.innerHTML = (fns[state.page] || pageDashboard)();
  afterRender();
}

// =============================================================== dashboard
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
          <span class="badge ${s.role === 'iran' ? 'ok' : ''}">${s.role === 'iran' ? 'ایران' : 'خارج'}</span>
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
          <button class="sm" data-srv-edit="${s.id}">ویرایش</button>
          <button class="sm" data-srv-probe="${s.id}">بررسی</button>
          <button class="sm" data-srv-conn="${s.id}">اتصال کلاینت</button>
          <button class="sm danger" data-srv-del="${s.id}">حذف</button>
        </td>
      </tr>`;
    })
    .join('');

  return `
  <div class="page-head">
    <h2>سرورها</h2>
    <span class="desc">سرور ایران و سرور خارج که واتروال روی آن‌ها اجرا می‌شود</span>
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
    <pre class="code" style="direction:ltr;text-align:left">curl -fsSL ${esc(location.origin)}/install.sh | sudo bash -s -- \\
  --panel-url ${esc(location.origin)} \\
  --agent-token AGENT_TOKEN</pre>
    <div class="small muted">توکن هر سرور جداست: در جدول بالا دکمه «ویرایش» را بزنید.</div>

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
      <textarea id="agentCmd" readonly style="min-height:150px">curl -fsSL ${location.origin}/install-agent.sh | sudo WW_PANEL_URL="${location.origin}" WW_AGENT_TOKEN="${server.agentToken || ''}" bash</textarea></label>
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

// ================================================================ tunnels
function pageTunnels() {
  const rows = state.tunnels
    .map((t) => {
      const tpl = state.templates.find((x) => x.id === t.template);
      return `
      <tr>
        <td><strong>${esc(t.name)}</strong>${t.notes ? `<br><span class="small muted">${esc(t.notes)}</span>` : ''}</td>
        <td><span class="badge">${tpl?.icon || ''} ${esc(tpl?.titleFa || t.template)}</span></td>
        <td><span class="badge ${t.enabled ? 'ok' : 'mute'}">${t.enabled ? 'فعال' : 'غیرفعال'}</span></td>
        <td class="small">${fmtDate(t.updatedAt)}</td>
        <td style="white-space:nowrap">
          <button class="sm primary" data-tn-open="${t.id}">باز کردن</button>
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
    ${sides.map((s) => `<span class="tab ${s === side ? 'active' : ''}" data-side="${s}">${s === 'iran' ? '🇮🇷 ایران' : '🌍 خارج'}</span>`).join('')}
    ${names.map((f) => `<span class="tab ${f === active ? 'active' : ''}" data-file="${esc(f)}">${esc(f)}</span>`).join('')}
  </div>
  <pre class="code" id="previewCode">${highlight(files[active])}</pre>
  <div class="row mt">
    <button class="sm" id="copyFile">📋 کپی این فایل</button>
    <button class="sm" id="downloadAll">⬇️ دانلود همه فایل‌ها</button>
    <span class="small muted">فایل‌های سمت ${side === 'iran' ? 'ایران' : 'خارج'}</span>
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
  try {
    const r = await api(`/api/tunnels/${t.id}`, {
      method: 'PATCH',
      body: { name: t.name, notes: t.notes, enabled: t.enabled, options: t.options },
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
  try {
    const r = await api('/api/preview', {
      method: 'POST',
      body: { template: t.template, name: t.name, options: t.options, targetServers: t.targetServers },
    });
    state.preview = r;
    state.activePreviewTab = Object.keys(r.bundles || {})[0] || 'iran';
    state.previewFile = null;
    if (r.optionsPatch) {
      // Persist generated secrets (WireGuard keypairs) so they stay stable.
      await api(`/api/tunnels/${t.id}`, { method: 'PATCH', body: { options: { ...t.options, ...r.optionsPatch } } });
      state.draft.options = { ...t.options, ...r.optionsPatch };
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
 */
function reachabilityHtml(r) {
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
    .map(
      (p) => `<div class="err-box">
        ${esc(p.message)}
        ${p.fix ? `<br><span class="small">رفع: <code class="mono" style="direction:ltr;display:inline-block">${esc(p.fix)}</code></span>` : ''}
      </div>`,
    )
    .join('');

  const good = r.ok
    ? '<div class="ok-box">✓ هر دو سرور به پورت‌های مورد نیاز یکدیگر دسترسی دارند.</div>'
    : '';

  return `<div style="margin-top:14px">
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
        const label = side === 'iran' ? '🇮🇷 ایران' : '🌍 خارج';
        return res.ok
          ? `<div class="ok-box">${label}: ${esc(res.dryRun ? 'dry-run OK — ' : '')}${esc((res.files || res.uploaded || []).join(', '))}${
              res.service?.output ? `<br>سرویس: ${esc(res.service.output)}` : ''
            }</div>`
          : `<div class="err-box">${label}: ${esc(res.error)}</div>`;
      })
      .join('');
    openModal(
      dryRun ? 'اعمال آزمایشی' : 'نتیجه اعمال',
      (lines || '<p class="muted">چیزی برای نمایش نیست.</p>') + reachabilityHtml(r.reachability),
      [{ text: 'بستن', class: 'primary', onClick: closeModal }],
    );
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

function templateFormHtml(tpl) {
  const iran = state.servers.filter((s) => s.role === 'iran');
  const foreign = state.servers.filter((s) => s.role === 'foreign');
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
      <div class="grid c2" style="gap:10px">
        <label class="f"><span class="lbl">سرور ایران</span>
          <select id="nt_iran">${iran.length ? iran.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') : '<option value="">— ثبت نشده —</option>'}</select></label>
        <label class="f"><span class="lbl">سرور خارج</span>
          <select id="nt_foreign">${foreign.length ? foreign.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') : '<option value="">— ثبت نشده —</option>'}</select></label>
      </div>
    </div>
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
      core: 'تنظیمات core.json',
      advanced: 'پیشرفته',
      wg: 'WireGuard',
      tun: 'اینترفیس TUN',
      transport: 'انتقال',
      dns: 'DNS',
      reverse: 'لینک معکوس',
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

function fieldHtml(f) {
  const id = `nf_${f.key}`;
  const req = f.required ? '<span class="req">*</span>' : '';
  const hint = f.help ? `<span class="hint">${esc(f.help)}</span>` : '';
  let input = '';

  switch (f.type) {
    case 'number':
      input = `<input type="number" id="${id}" data-key="${f.key}" data-type="number" value="${esc(f.default ?? '')}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}>`;
      break;
    case 'password':
      input = `<div class="row" style="gap:6px"><input type="password" id="${id}" data-key="${f.key}" data-type="text" value="" placeholder="${esc(String(f.default || '').replace('auto:', 'خودکار: '))}">
        <button class="sm" data-gen="${f.key}">🎲</button></div>`;
      break;
    case 'boolean':
      input = `<label class="switch"><input type="checkbox" id="${id}" data-key="${f.key}" data-type="boolean" ${f.default ? 'checked' : ''}><span class="track"></span><span>${esc(f.label)}</span></label>`;
      break;
    case 'select':
      input = `<select id="${id}" data-key="${f.key}" data-type="text">${(f.options || [])
        .map((o) => `<option value="${esc(o)}" ${o === f.default ? 'selected' : ''}>${esc(o)}</option>`)
        .join('')}</select>`;
      break;
    case 'list':
      input = `<div class="list-input" data-list="${f.key}">
          <input type="text" data-key="${f.key}" data-type="list" placeholder="${esc(f.placeholder || 'مقدار، با کاما جدا کنید')}">
          <button class="sm" data-add="${f.key}">+</button>
        </div><div class="chips" id="chips_${f.key}"></div>`;
      break;
    case 'csv':
      input = `<input type="text" id="${id}" data-key="${f.key}" data-type="csv" value="${esc((f.default || []).join(', '))}">`;
      break;
    case 'keyvalue':
      input = `<div data-kv="${f.key}"></div><button class="sm mt" data-kvadd="${f.key}">+ کاربر</button>`;
      break;
    case 'users':
      input = `<div data-users="${f.key}"></div><button class="sm mt" data-useradd="${f.key}">+ کاربر</button>`;
      break;
    default:
      input = `<input type="text" id="${id}" data-key="${f.key}" data-type="text" value="${esc(f.default ?? '')}">`;
  }
  return `<label class="f" data-field="${f.key}" ${f.when ? `data-when='${esc(JSON.stringify(f.when))}'` : ''}>
      <span class="lbl">${esc(f.label)} ${req}</span>${input}${hint}
    </label>`;
}

function collectForm(tpl) {
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
      if (raw === '') continue;
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
  const options = collectForm(tpl);
  try {
    const r = await api('/api/tunnels', {
      method: 'POST',
      body: {
        name,
        template: tpl.id,
        notes: $('#nt_notes').value.trim(),
        options,
        targetServers: { iran: $('#nt_iran').value || null, foreign: $('#nt_foreign').value || null },
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
            <td><span class="badge ${s.role === 'iran' ? 'ok' : ''}">${s.role === 'iran' ? 'ایران' : 'خارج'}</span></td>
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
        .map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name) + ' (' + esc(x.role === 'iran' ? 'ایران' : 'خارج') + ')</option>')
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
  if ($('#dashLog')) loadEvents();

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
      if (!confirm('این تونل حذف شود؟')) return;
      await api(`/api/tunnels/${b.dataset.tnDel}`, { method: 'DELETE' });
      state.tunnels = state.tunnels.filter((x) => x.id !== b.dataset.tnDel);
      toast('حذف شد', 'ok');
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
function initDynamicFields(tpl) {
  // chips for list fields
  for (const f of tpl.fields.filter((x) => x.type === 'list')) {
    renderChips(f.key, [].concat(f.default || []));
  }
  // keyvalue rows
  for (const f of tpl.fields.filter((x) => x.type === 'keyvalue')) {
    const host = $(`[data-kv="${f.key}"]`);
    (f.default || []).forEach((row) => addKvRow(host, row));
  }
  // user rows
  for (const f of tpl.fields.filter((x) => x.type === 'users')) {
    const host = $(`[data-users="${f.key}"]`);
    (f.default || []).forEach((row) => addUserRow(host, row));
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
async function loadEvents() {
  const host = $('#dashLog');
  if (!host) return;
  const res = await fetch(`/api/events?token=${encodeURIComponent(state.token)}`, {
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
      try {
        const e = JSON.parse(dataLine.slice(5).trim());
        lines.push(e);
        push(`${new Date(e.at).toLocaleTimeString('fa-IR')}  ${e.type}  ${JSON.stringify(e).slice(0, 160)}`);
      } catch {
        /* ignore */
      }
    }
  }
}

window.__wwToken = state.token;
window.copy = copy;

// ------------------------------------------------------------------ start
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
