'use strict';

/**
 * WaterWall version knowledge.
 *
 * WaterWall moves fast and removes settings outright rather than deprecating
 * them: an obsolete key is a *startup error*, not a warning. A panel that
 * happily generates yesterday's config therefore produces tunnels that refuse
 * to come up, which is the worst possible failure mode.
 *
 * So the panel carries a small registry of what changed, lints every generated
 * config against it, and knows which templates need which release.
 */

/** The release this panel is written against. */
const CURRENT = '1.46.96';

/** Oldest release the panel still generates sane configs for. */
const OLDEST_SUPPORTED = '1.46.8';

// ------------------------------------------------------------------ compare

/**
 * Compare dotted version strings. Returns <0, 0 or >0.
 *
 * WaterWall versions look like "1.46.96". A plain numeric compare is wrong for
 * them: 96 > 8 must be true when the minor differs, but 8 > 96 must be true
 * within the same minor, so each component has to be compared separately and
 * only then by position.
 */
function cmp(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const gte = (a, b) => cmp(a, b) >= 0;
const lt = (a, b) => cmp(a, b) < 0;

/** Normalise user input ("v1.46.96", " 1.46.96 ") to a bare dotted string. */
function normalise(version) {
  const m = String(version || '').trim().match(/(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ registry

/**
 * Settings WaterWall no longer accepts. `since` is the release that started
 * rejecting them; `nodes` limits the lint to the relevant node types.
 *
 * A config containing any of these fails at startup with an error naming the
 * offending key, so the panel blocks it before anything is deployed.
 */
const REMOVED_SETTINGS = [
  {
    key: 'max-frame-size',
    nodes: ['RealityServer', 'RealityClient'],
    since: '1.46.96',
    reason:
      'Reality دیگر max-frame-size را نمی‌پذیرد و آن را خطای startup می‌دهد. این تنظیم فقط برای EncryptionClient/EncryptionServer معتبر است.',
    reasonEn:
      'Reality rejects max-frame-size as a startup error. The setting is only valid on EncryptionClient/EncryptionServer.',
  },
  {
    key: 'protoswap-tcp-2',
    nodes: ['IpManipulator'],
    since: '1.46.96',
    reason:
      'protoswap-tcp-2 حذف شده و کانفیگ حاوی آن رد می‌شود. از نگاشت تک‌طرفه و برگشت‌پذیر protoswap-tcp استفاده کنید.',
    reasonEn: 'protoswap-tcp-2 was removed and stale configs are rejected. Use the reversible protoswap-tcp mapping.',
  },
  {
    // Ping v1 carried a family of strategy keys; v2 accepts only the listed set.
    key: 'strategy',
    nodes: ['PingClient', 'PingServer'],
    since: '1.46.96',
    reason: 'Ping نسخه ۲ فقط local-ipv4، peer-ipv4، send-replies، identifier، sequence-start، ttl و tos را می‌پذیرد.',
    reasonEn: 'Ping v2 accepts only local-ipv4, peer-ipv4, send-replies, identifier, sequence-start, ttl and tos.',
  },
  {
    key: 'source',
    nodes: ['PingClient', 'PingServer'],
    since: '1.46.96',
    reason: 'Ping نسخه ۲ تنظیمات نسخه ۱ را رد می‌کند؛ به‌جای source از local-ipv4/peer-ipv4 استفاده کنید.',
    reasonEn: 'Ping v2 rejects v1 settings; use local-ipv4 / peer-ipv4 instead of source.',
  },
  {
    key: 'dest',
    nodes: ['PingClient', 'PingServer'],
    since: '1.46.96',
    reason: 'Ping نسخه ۲ تنظیمات نسخه ۱ را رد می‌کند؛ به‌جای dest از local-ipv4/peer-ipv4 استفاده کنید.',
    reasonEn: 'Ping v2 rejects v1 settings; use local-ipv4 / peer-ipv4 instead of dest.',
  },
  {
    key: 'mode',
    nodes: ['UdpOverTcpClient', 'UdpOverTcpServer'],
    since: '1.46.96',
    reason: 'حالت TCP از UdpOverTcp حذف شده؛ قاب‌بندی ۲ بایتی همیشه فعال است و تنظیمات باید خالی باشد.',
    reasonEn: 'TCP mode was removed from UdpOverTcp; the 2-byte framing is always active and settings must be empty.',
  },
];

/** Ping v2's complete settings allowlist, used to reject anything else. */
const PING_V2_KEYS = new Set([
  'local-ipv4',
  'peer-ipv4',
  'send-replies',
  'identifier',
  'sequence-start',
  'ttl',
  'tos',
]);

/**
 * Features that only exist from a given release. Templates declare the ones
 * they use so the panel can tell the user to upgrade instead of deploying a
 * config the core will refuse.
 */
const FEATURES = {
  streamFragmenter: '1.46.96',
  packetsToConnection: '1.46.96',
  httpProxyClient: '1.46.96',
  realityV2: '1.46.96',
  perNodeMtu: '1.46.96',
  splice: '1.46.96',
  pingV2: '1.46.96',
  tcpTune: '1.46.96',
  ipManipulatorSni: '1.46.0',
  protoswap: '1.46.0',
  bitSwap: '1.46.0',
};

/** Short human summary of what a release brought, for the UI. */
const RELEASE_NOTES = {
  '1.46.96': {
    date: '2026-10-04',
    headline: 'splice در سراسر زنجیره، Mux آگاه به splice، TUN GSO/TSO و چک‌سام AVX2',
    headlineEn: 'Full-chain splice, splice-aware Mux, TUN GSO/TSO and an AVX2 checksum backend',
    highlights: [
      'splice() لینوکس در کل زنجیره‌های سازگار — داده در صف‌های کرنل می‌ماند و بین کرنل و یوزراسپیس رونویسی نمی‌شود',
      'MuxClient/MuxServer حالا با splice کار می‌کنند بدون از دست دادن قاب‌بندی MUX',
      'TUN از offloadهای virtio-net استفاده می‌کند: TUN_F_CSUM، TUN_F_TSO4 و TCPv4 GSO',
      'چک‌سام اینترنت بهینه شد؛ بک‌اند AVX2 برای CPUهای x86-64 پشتیبانی‌شده',
      'PacketsToConnection عملی شد: TunDevice → PacketsToConnection → Socks5Client → TcpUdpConnector (مثل tun2socks)',
      'نود جدید StreamFragmenter: تکه‌تکه کردن TLS ClientHello و بریدن با تأخیر، بدون نیاز به raw socket',
      'نود جدید HttpProxyClient با DNS مبدأ و پشتیبانی splice',
      'تنظیم MTU به‌ازای هر نود اضافه شد و گزینه اجرای tcp-tune در استارت آپ لینوکس',
      'Reality نسخه ۲: aes-gcm در کنار chacha20-poly1305، salt و kdf-iterations قابل تنظیم، و بازپخش‌محافظی',
    ],
    breaking: [
      'PingClient/PingServer به نسخه ۲ رفتند و با نسخه ۱ روی سیم سازگار نیستند',
      'max-frame-size در RealityServer/RealityClient خطای startup است',
      'protoswap-tcp-2 از IpManipulator حذف شد',
      'حالت TCP از UdpOverTcp حذف شد',
      'نودهای TcpListener/TcpConnector برای زنجیره‌های Mux مقادیر بافر پیش‌فرض جدیدی گرفتند',
    ],
  },
};

// ------------------------------------------------------------------ linting

/**
 * Walk a parsed node config and report settings WaterWall would reject.
 *
 * Operates on the parsed JSON *after* variable substitution, because that is
 * what the core actually parses.
 *
 * @returns {Array<{node: string, type: string, key: string, reason: string}>}
 */
function lintConfig(config) {
  const problems = [];
  const nodes = Array.isArray(config?.nodes) ? config.nodes : [];

  for (const n of nodes) {
    const settings = n?.settings;
    if (!settings || typeof settings !== 'object') continue;
    const type = String(n.type || '');
    // A key can be covered by both the removed list and the Ping allowlist;
    // report it once.
    const seen = new Set();

    for (const rule of REMOVED_SETTINGS) {
      if (!rule.nodes.includes(type)) continue;
      if (!(rule.key in settings)) continue;
      seen.add(rule.key);
      problems.push({
        node: n.name,
        type,
        key: rule.key,
        since: rule.since,
        reason: rule.reason,
      });
    }

    // Ping v2 is a closed set: anything outside the allowlist is rejected.
    if (type === 'PingClient' || type === 'PingServer') {
      for (const key of Object.keys(settings)) {
        if (PING_V2_KEYS.has(key) || seen.has(key)) continue;
        problems.push({
          node: n.name,
          type,
          key,
          since: '1.46.96',
          reason:
            'Ping نسخه ۲ تنظیمات نسخه ۱ را نمی‌پذیرد و با خطا رد می‌کند. تنظیمات مجاز: local-ipv4، peer-ipv4، send-replies، identifier، sequence-start، ttl، tos.',
        });
      }
    }
  }

  return problems;
}

/** Lint a config that is still text (comments and $variables$ unresolved). */
function lintText(text) {
  try {
    return lintConfig(JSON.parse(text));
  } catch {
    return []; // unparseable input is reported by the generator's own validation
  }
}

// ------------------------------------------------------------------ feature checks

/** Which of the registered features a parsed config actually relies on. */
function featuresUsed(config) {
  const used = new Set();
  const types = new Set((config?.nodes || []).map((n) => String(n?.type || '')));

  if (types.has('StreamFragmenter')) used.add('streamFragmenter');
  if (types.has('PacketsToConnection')) used.add('packetsToConnection');
  if (types.has('HttpProxyClient')) used.add('httpProxyClient');
  if (types.has('PingClient') || types.has('PingServer')) used.add('pingV2');
  if (types.has('RealityServer') || types.has('RealityClient')) used.add('realityV2');

  for (const n of config?.nodes || []) {
    const s = n?.settings || {};
    if ('protoswap-tcp' in s || 'protoswap-udp' in s || 'protoswap' in s) used.add('protoswap');
    if (
      'first-sni' in s ||
      'smuggle-sni' in s ||
      'overlap-sni' in s ||
      'synfin-sni' in s ||
      'sni-blender' in s ||
      'ech-sni-trick' in s
    ) {
      used.add('ipManipulatorSni');
    }
    if (n?.mtu !== undefined) used.add('perNodeMtu');
  }
  return [...used];
}

/**
 * Check a generated config against a specific WaterWall version.
 *
 * Returns problems that make the config unusable on that release.
 */
function checkAgainstVersion(config, version) {
  const v = normalise(version);
  const problems = [];

  if (!v) {
    return { known: false, version: null, problems: [], features: featuresUsed(config) };
  }

  // Removed settings matter regardless of which version: if the key exists at
  // all, the panel should never have written it.
  for (const p of lintConfig(config)) {
    problems.push({
      kind: 'removed-setting',
      node: p.node,
      key: p.key,
      message: `${p.node} (${p.type}): ${p.reason}`,
    });
  }

  const missing = [];
  for (const feature of featuresUsed(config)) {
    const since = FEATURES[feature];
    if (since && lt(v, since)) missing.push({ feature, since });
  }
  for (const m of missing) {
    problems.push({
      kind: 'too-old',
      feature: m.feature,
      message: `این کانفیگ از قابلیت «${m.feature}» استفاده می‌کند که از نسخه ${m.since} اضافه شده، ولی سرور نسخه ${v} دارد.`,
    });
  }

  return { known: true, version: v, problems, features: featuresUsed(config) };
}

/**
 * Compare a tunnel's requirements against what a server reports running.
 *
 * @param {object} template
 * @param {object|null} server  a store server record (may carry .lastStatus)
 */
function checkServer(template, server) {
  const reported = normalise(server?.lastStatus?.waterwallVersion || server?.waterwallVersion);
  if (!reported) {
    return {
      known: false,
      reported: null,
      problems: [],
      message: 'نسخه واتروال روی این سرور هنوز گزارش نشده — از ایجنت بخواهید وضعیت را بفرستد یا خودتان در سرور بررسی کنید.',
    };
  }

  const min = template?.minVersion || null;
  const problems = [];
  if (min && lt(reported, min)) {
    problems.push({
      kind: 'too-old',
      message: `این قالب به واتروال ${min} یا بالاتر نیاز دارد ولی روی این سرور ${reported} نصب است.`,
    });
  }
  if (lt(reported, OLDEST_SUPPORTED)) {
    problems.push({
      kind: 'unsupported',
      message: `نسخه ${reported} قدیمی‌تر از پایین‌ترین نسخه پشتیبانی‌شده پنل (${OLDEST_SUPPORTED}) است. لطفاً واتروال را به‌روز کنید.`,
    });
  }

  return { known: true, reported, problems, message: null };
}

module.exports = {
  CURRENT,
  OLDEST_SUPPORTED,
  REMOVED_SETTINGS,
  FEATURES,
  RELEASE_NOTES,
  cmp,
  gte,
  lt,
  normalise,
  lintConfig,
  lintText,
  featuresUsed,
  checkAgainstVersion,
  checkServer,
};