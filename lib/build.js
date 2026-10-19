'use strict';

const crypto = require('node:crypto');
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
  // Without every side there is no complete tunnel to build. This also keeps a
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

  const fileName = `configs/${slug(tunnel.name) || 'tunnel'}.json`;
  const bundles = {};
  const problems = [];

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
    if (files[fileName]) {
      // template already produced a node config under its own name
    } else {
      // nothing: template must supply files
    }
    const nodeConfigs = Object.keys(files).filter((f) => f.startsWith('configs/'));
    if (nodeConfigs.length === 0) {
      problems.push(`${side}: bundle has no configs/*.json node config file`);
      continue;
    }
    const finalFiles = bundleCore(files, sideBundle.core || {});
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

module.exports = {
  buildBundle,
  renderClientConfig,
  materialiseOptions,
  resolveOptions,
  regenerateOptions,
};
