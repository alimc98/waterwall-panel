'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { clone, prune, uuid: newUuid, slug } = require('./util');
const { bundleCore, validateBundle } = require('./generator');
const templates = require('./templates');
const versions = require('./versions');
const { resolveTargets } = require('./targets');

/**
 * Turn a stored tunnel definition into ready-to-write WaterWall config files
 * for both sides of the link.
 */

const AUTO = {
  uuid: () => newUuid(),
  password: () => crypto.randomBytes(24).toString('base64url'),
  shortid: () => crypto.randomBytes(8).toString('hex'),
  hex: (n) => () => crypto.randomBytes(Number(n) || 8).toString('hex'),
  salt: () => crypto.randomBytes(8).toString('hex'),
  password16: () => crypto.randomBytes(16).toString('hex'),
};

function resolveAuto(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.startsWith('auto:')) return value;
  const [kind, arg] = value.slice('auto:'.length).split(':');
  const fn = AUTO[kind];
  if (!fn) return undefined;
  return arg !== undefined ? fn(arg)() : fn();
}

/**
 * Replace the *literal* `auto:` placeholders in the stored options with real
 * generated values. Only values that are still placeholders are touched, so a
 * password that was generated on the first build stays stable afterwards.
 */
function resolvePending(template, options) {
  const out = clone(options || {});
  let changed = false;
  for (const field of template.fields || []) {
    const current = out[field.key];
    if (typeof current !== 'string' || !current.startsWith('auto:')) continue;
    const resolved = resolveAuto(current);
    if (resolved !== undefined) {
      out[field.key] = resolved;
      changed = true;
    }
  }
  return changed ? out : options || {};
}

/**
 * WaterWall's TcpListener whitelist/blacklist settings want CIDRs, but the
 * panel's fields (and its documentation) accept a plain IP as a convenience.
 * Normalize those lists once, centrally, instead of relying on every template
 * to remember the `/32`. Entries that are already CIDRs or that are template
 * variable references (`@name` / `$name$`) are left untouched.
 *
 * This works on the text, not on JSON.parse: several templates emit unquoted
 * `$variable$` placeholders for numeric fields (for example `"port": $port$`),
 * so the file is not valid JSON until the WaterWall loader resolves the
 * variables. A JSON round-trip would silently skip those configs — and the CDN
 * templates are exactly the ones where a raw whitelist IP used to reach the
 * core unchanged. Replacing only the quoted entries also preserves the
 * byte-for-byte output of configs that need no change, so an existing working
 * tunnel keeps its hash and is not restarted.
 */
function normaliseIpListFile(text) {
  return text.replace(/("(?:whitelist|blacklist)"\s*:\s*\[)([\s\S]*?)(\])/g, (match, open, body, close) => {
    const normalised = body.replace(/"([^"]*)"/g, (entry, value) => {
      const host = value.trim();
      if (!host || host.includes('/') || host.startsWith('@') || host.startsWith('$')) return entry;
      return `"${host.includes(':') ? `${host}/128` : `${host}/32`}"`;
    });
    return open + normalised + close;
  });
}

/** Fill every declared field with its default (generating secrets on the way). */
function materialiseOptions(template, options) {
  const out = {};
  for (const field of template.fields || []) {
    if (options && options[field.key] !== undefined && options[field.key] !== null && options[field.key] !== '') {
      out[field.key] = options[field.key];
    } else {
      out[field.key] = clone(field.default);
    }
  }
  // keep unknown keys (forward compatibility)
  for (const [k, v] of Object.entries(options || {})) {
    if (out[k] === undefined) out[k] = v;
  }
  for (const [k, v] of Object.entries(clone(out))) {
    const resolved = resolveAuto(v);
    if (resolved === undefined) delete out[k];
    else out[k] = resolved;
  }
  return prune(out);
}

/**
 * Do the two ends of this tunnel run the same WaterWall release?
 *
 * Some node pairs are not compatible across releases. The reverse templates
 * put a ReverseClient on the exit and a ReverseServer on the Iran box, and
 * from 1.5.0 onwards the two halves of that pair speak different protocols.
 * The same applies to AuthenticationClient/AuthenticationServer.
 *
 * A tunnel whose ends disagree therefore builds fine, uploads fine, and then
 * never carries a byte — which looks like a network problem rather than a
 * version problem. Saying it up front saves the hunt.
 *
 * @param {Object} sideServers  the server record of each side
 * @param {string[]} sides      the sides the template actually builds
 * @returns {string|null} a warning, or null when nothing is known or wrong
 */
function versionMismatch(sideServers, sides) {
  const reported = [];
  for (const side of sides) {
    const srv = sideServers[side];
    if (!srv) continue;
    const version = versions.normalise(srv.lastStatus?.waterwallVersion || srv.waterwallVersion);
    if (!version) continue;
    reported.push({ side, version });
  }
  if (reported.length < 2) return null;
  const distinct = [...new Set(reported.map((r) => r.version))];
  if (distinct.length < 2) return null;
  const detail = reported.map((r) => `${r.side}=${r.version}`).join('، ');
  return (
    `نسخهٔ واتروال دو سرور این تونل یکسان نیست (${detail}). ` +
    'از نسخهٔ ۱.۵.۰ به بعد ReverseClient/ReverseServer و AuthenticationClient/AuthenticationServer ' +
    'باید هم‌زمان ارتقا یابند؛ تا وقتی هر دو سرور روی یک نسخه نیستند این تونل بالا نمی‌آید.'
  );
}

function buildBundle(store, tunnel) {
  const template = templates.get(tunnel.template);
  if (!template) {
    return {
      ok: false,
      problems: [`unknown template "${tunnel.template}"`],
      bundles: {},
      notes: [],
      warnings: [],
    };
  }

  const servers = store.listServers();
  const declaredSides =
    Array.isArray(template.sides) && template.sides.length ? template.sides : ['iran', 'foreign'];
  const { iran: iranServer, foreign: foreignServers, relay: relayServer } = resolveTargets(servers, tunnel);
  const foreignServer = foreignServers[0] || null;
  const sideServers = { iran: iranServer, relay: relayServer, foreign: foreignServer };
  // A template declares the sides it actually builds. Most need both, but a
  // single-sided template such as `tcp-relay` is a middle hop with no exit of
  // its own, so a missing foreign server must not block it. This also keeps a
  // reverse listener from being emitted with an empty whitelist, which would
  // read as "accept every reverse client" on the wire.
  const missing = declaredSides.filter((side) => (side === 'foreign' ? !foreignServers.length : !sideServers[side]));
  if (missing.length) {
    const names = { iran: 'Iran', relay: 'relay', foreign: 'foreign' };
    return {
      ok: false,
      problems: [
        `no ${missing.map((side) => names[side] || side).join(' and ')} server is selected; add at least one server for every side of this scenario before building a tunnel`,
      ],
      bundles: {},
      notes: [],
      warnings: [],
    };
  }

  // Resolve `auto:` defaults *before* materialising, so a value that was
  // already generated and stored is reused instead of being re-rolled on every
  // build. Both sides of a tunnel must agree on secrets such as the Reality
  // password, so they are generated once and persisted by the caller.
  let options = materialiseOptions(template, resolvePending(template, tunnel.options));
  // Templates read these values directly off `options`; fill them in from the
  // registered servers so a template never needs to know the panel's shape.
  // `foreignHosts` is the whole exit fleet: reverse templates use it to
  // whitelist every server that is allowed to dial the Iran entry.
  options = {
    ...options,
    iranHost: iranServer?.host || options.iranHost || '',
    foreignHost: foreignServer?.host || options.foreignHost || '',
    relayHost: relayServer?.host || options.relayHost || '',
    foreignHosts: foreignServers.length
      ? foreignServers.map((s) => s.host)
      : Array.isArray(options.foreignHosts)
        ? options.foreignHosts
        : [],
  };
  const ctx = {
    tunnel,
    options,
    template,
    iranServer,
    relayServer,
    foreignServer,
    foreignServers,
    sideServers,
    iranHost: options.iranHost,
    relayHost: options.relayHost,
    foreignHost: options.foreignHost,
    log: (msg) => store.log({ type: 'template', tunnelId: tunnel.id, message: String(msg) }),
  };

  let built;
  let optionsPatch = null;
  if (typeof template.ensureOptions === 'function') {
    try {
      const patch = template.ensureOptions(options, ctx);
      if (patch && typeof patch === 'object' && Object.keys(patch).length) {
        optionsPatch = patch;
        options = { ...options, ...patch };
        ctx.options = options;
      }
    } catch (err) {
      return {
        ok: false,
        problems: [`template provisioning failed: ${err.message}`],
        bundles: {},
        notes: [],
        warnings: [],
      };
    }
  }

  try {
    built = template.build(ctx);
  } catch (err) {
    return {
      ok: false,
      problems: [`template build failed: ${err.message}`],
      bundles: {},
      notes: [],
      warnings: [],
    };
  }

  const bundles = {};
  const problems = [];

  /**
   * One node-config file per tunnel.
   *
   * Templates name their config after the scenario (`reverse-reality.json`,
   * `cdn-reverse-wss.json`, …). That is fine for a single tunnel, but two
   * tunnels of the same scenario on one server wrote the same path and the
   * second overwrote the first — the first tunnel kept running until the next
   * restart and then silently disappeared. The suffix is derived from the
   * tunnel id, so it is stable across rebuilds (an unchanged config keeps its
   * hash and is not restarted) and unique among tunnels. Templates that already
   * embed the id (the relay chain) are left alone.
   */
  const idSuffix = String(tunnel.id || 'tunnel').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'tunnel';
  const uniqueConfigPath = (rel) => {
    if (!rel.startsWith('configs/') || !rel.endsWith('.json')) return rel;
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel, '.json');
    if (base.endsWith(`-${idSuffix}`) || base.endsWith(`_${idSuffix}`)) return rel;
    const safe = slug(base) || 'tunnel';
    return `${dir}/${safe}-${idSuffix}.json`;
  };

  const builtSides = [
    ...new Set([
      ...declaredSides,
      ...Object.keys(built || {}).filter((key) => built?.[key] && typeof built[key] === 'object' && built[key].files),
    ]),
  ];
  for (const side of builtSides) {
    const sideBundle = built?.[side];
    if (!sideBundle) {
      if (declaredSides.includes(side)) problems.push(`${side}: template produced no bundle for this side`);
      continue;
    }
    const files = { ...sideBundle.files };
    for (const [rel, content] of Object.entries(files)) {
      const unique = uniqueConfigPath(rel);
      if (unique === rel) continue;
      delete files[rel];
      files[unique] = content;
    }
    const nodeConfigs = Object.keys(files).filter((f) => f.startsWith('configs/'));
    if (nodeConfigs.length === 0) {
      problems.push(`${side}: bundle has no configs/*.json node config file`);
      continue;
    }
    const finalFiles = bundleCore(files, sideBundle.core || {});
    for (const file of Object.keys(finalFiles)) {
      if (file.startsWith('configs/')) finalFiles[file] = normaliseIpListFile(finalFiles[file]);
    }
    problems.push(...validateBundle(finalFiles).map((p) => `${side}: ${p}`));

    // WaterWall rejects removed settings outright (a startup error, not a
    // warning), so catch them here rather than after the service refuses to
    // start on the server. Lint the *substituted* config, which is what the
    // core actually parses.
    for (const file of Object.keys(finalFiles)) {
      if (!file.startsWith('configs/')) continue;
      for (const hit of versions.lintText(finalFiles[file])) {
        problems.push(
          `${side}/${file}: تنظیم «${hit.key}» در ${hit.type} از نسخه ${hit.since} حذف شده و باعث خطای اجرا می‌شود. ${hit.reason}`,
        );
      }
    }

    bundles[side] = finalFiles;
  }

  // A server running an older core cannot load these configs at all, so say so
  // before deployment rather than after a failed service start.
  const warnings = [...(built?.warnings || [])];
  for (const side of declaredSides) {
    const srv = side === 'foreign' ? foreignServer : sideServers[side];
    const check = versions.checkServer(template, srv);
    for (const p of check.problems) warnings.push(`${side}: ${p.message}`);
  }
  // The two ends of a tunnel have to run the same core. The reverse templates
  // pair a ReverseClient with a ReverseServer, and since 1.5.0 the two halves
  // of that pair speak different protocols: a client on 1.46.96 and a server on
  // 1.5.0 (or the other way round) never connect, and the failure looks like a
  // dead tunnel rather than a version mismatch.
  const mismatched = versionMismatch(sideServers, declaredSides);
  if (mismatched) warnings.push(mismatched);

  return {
    ok: problems.length === 0,
    problems,
    bundles,
    options,
    optionsPatch,
    notes: built?.notes || [],
    warnings,
    client: built?.client || null,
    // Optional per-template metadata the UI can act on (e.g. protocol scan).
    probe: built?.probe || null,
  };
}

/** Client connection material (links, config snippets) for the UI. */
function renderClientConfig(store, tunnel) {
  const built = buildBundle(store, tunnel);
  const tpl = templates.get(tunnel.template);
  const client = built.client;
  if (!client) {
    return {
      available: false,
      reason: 'This template does not expose client connection details (it is an internal relay/test chain).',
    };
  }
  return {
    available: true,
    links: client.links || [],
    json: client.json ? JSON.stringify(client.json, null, 2) : null,
    text: client.text || null,
    instructions: client.instructions || (tpl?.clientHint || null),
  };
}

/**
 * Fields whose default is an `auto:` placeholder. Used by the "regenerate
 * secrets" action so the panel knows what may be safely re-rolled.
 */
function autoFields(template) {
  return (template.fields || []).filter((f) => typeof f.default === 'string' && f.default.startsWith('auto:'));
}

/**
 * Fully resolve a form payload into concrete option values. Called when a
 * tunnel is saved so that generated secrets (UUIDs, passwords, WireGuard
 * keypairs) are persisted instead of being re-rolled on every preview.
 */
function resolveOptions(templateId, options, tunnelLike = {}) {
  const template = templates.get(templateId);
  if (!template) return options || {};
  const resolved = materialiseOptions(template, options || {});
  if (typeof template.ensureOptions === 'function') {
    const patch = template.ensureOptions(resolved, {
      tunnel: tunnelLike,
      options: resolved,
      iranHost: tunnelLike.iranHost,
      foreignHost: tunnelLike.foreignHost,
      log: () => {},
    });
    if (patch) Object.assign(resolved, patch);
  }
  return resolved;
}

/** Drop every auto-generated value so the next build produces fresh ones. */
function regenerateOptions(templateId, options) {
  const template = templates.get(templateId);
  if (!template) return options || {};
  const next = { ...(options || {}) };
  for (const field of autoFields(template)) delete next[field.key];
  if (template.ensureOptions) {
    for (const key of ['wgIran', 'wgForeign']) delete next[key];
  }
  return next;
}

/**
 * Per-exit foreign bundle for a reverse tunnel.
 *
 * A reverse tunnel can have several exits. Only the first one (the "main"
 * exit) needs to host the local service; the other exits just provide extra
 * reverse links and bridge into the main exit's service. Applying the same
 * bundle to every exit would make a helper try to reach a service that does
 * not exist on its own box, so its bundle points at the main exit's address
 * instead of 127.0.0.1.
 *
 * The file name stays the same for every exit; only the `outbound_to_local_service`
 * node changes. Parsing and re-serialising keeps the `$variables$` placeholders
 * intact because they are ordinary JSON strings.
 */
function tailorForeignBundle(files, mainHost) {
  const result = {};
  for (const [name, text] of Object.entries(files || {})) {
    if (!name.endsWith('.json') || name === 'core.json' || typeof text !== 'string') {
      result[name] = text;
      continue;
    }
    // The foreign config is not strict JSON when variables are enabled
    // (`"port": $final_port$`), so edit it as text. The outbound node is the
    // first one in the file, and its `address` is the only quoted address we
    // want to change.
    const marker = '"outbound_to_local_service"';
    const start = text.indexOf(marker);
    if (start === -1) {
      result[name] = text;
      continue;
    }
    const addrKey = text.indexOf('"address"', start);
    if (addrKey === -1) {
      result[name] = text;
      continue;
    }
    const colon = text.indexOf(':', addrKey);
    const openQuote = text.indexOf('"', colon);
    const closeQuote = text.indexOf('"', openQuote + 1);
    if (colon === -1 || openQuote === -1 || closeQuote === -1) {
      result[name] = text;
      continue;
    }
    // `mainHost` is written inside a JSON string, so it has to be escaped the
    // way JSON.stringify escapes it: a host containing a quote or a backslash
    // must never be able to break out of the string (or inject a new key).
    const escapedHost = JSON.stringify(String(mainHost)).slice(1, -1);
    result[name] =
      text.slice(0, openQuote + 1) + escapedHost + text.slice(closeQuote);
  }
  return result;
}

module.exports = {
  buildBundle,
  renderClientConfig,
  materialiseOptions,
  resolveOptions,
  regenerateOptions,
  versionMismatch,
  tailorForeignBundle,
};
