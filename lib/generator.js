'use strict';

const { pretty, prune } = require('./util');

/**
 * Builds the runtime JSON files (`core.json` + `configs/*.json`) for a tunnel.
 * A template returns a bundle:
 *
 *   {
 *     iran:    { files: { 'core.json': '<text>', 'configs/x.json': '<text>' } },
 *     foreign: { files: { ... } },
 *     notes:   ['human readable hints'],
 *     warnings:['things to check before deploying'],
 *   }
 *
 * Only one side may be present for single-sided templates.
 */

const DEFAULT_CORE = (opts = {}) => ({
  log: {
    path: opts.logPath || 'log/',
    internal: { loglevel: opts.internalLogLevel || 'INFO', file: 'internal.log', console: false },
    core: { loglevel: opts.logLevel || 'INFO', file: 'core.log', console: true },
    network: { loglevel: opts.logLevel || 'INFO', file: 'network.log', console: true },
    dns: { loglevel: 'INFO', file: 'dns.log', console: false },
  },
  misc: {
    workers: Number(opts.workers) || 2,
    'ram-profile': opts.ramProfile || 'server',
    mtu: Number(opts.mtu) || 1500,
    splice: opts.splice !== false,
    'try-enabling-bbr': opts.bbr !== false,
    'libs-path': 'libs/',
  },
  dns: prune({
    'domain-strategy': opts.domainStrategy || 'prefer-ipv4',
    servers: opts.dnsServers && opts.dnsServers.length ? opts.dnsServers : undefined,
  }),
  configs: opts.configs,
});

function coreJson(opts) {
  return `${pretty(DEFAULT_CORE(opts))}\n`;
}

/** Wrap a node list into a WaterWall node config file. */
function chainConfig(name, nodes, extra = {}) {
  return {
    name,
    author: 'waterwall-panel',
    'config-version': 1,
    'core-minimum-version': 0,
    encrypted: false,
    ...extra,
    nodes,
  };
}

/** Merge every config file text into a single `core.json` that lists them all. */
function bundleCore(files, opts) {
  const configPaths = Object.keys(files)
    .filter((p) => p.startsWith('configs/'))
    .sort();
  const core = DEFAULT_CORE({ ...opts, configs: configPaths });
  return { 'core.json': `${pretty(core)}\n`, ...files };
}

/**
 * Validate a generated bundle: every `next` must resolve to a real node,
 * names must be unique, and there must be at least one head.
 */
function validateBundle(files) {
  const problems = [];
  for (const [file, text] of Object.entries(files)) {
    if (file === 'core.json' || !file.startsWith('configs/')) continue;
    // Node configs may use `//` comments and $variables$; resolve them first
    // so validation runs against what WaterWall will actually parse.
    const pre = preprocessConfig(text);
    problems.push(...pre.problems.map((p) => `${file}: ${p}`));
    let config;
    try {
      config = JSON.parse(pre.text);
    } catch (err) {
      problems.push(`${file}: invalid JSON (${err.message})`);
      continue;
    }
    if (!Array.isArray(config.nodes) || config.nodes.length === 0) {
      problems.push(`${file}: "nodes" must be a non-empty array`);
      continue;
    }
    const names = new Set();
    for (const node of config.nodes) {
      if (!node.name) problems.push(`${file}: a node is missing "name"`);
      if (names.has(node.name)) problems.push(`${file}: duplicate node name "${node.name}"`);
      names.add(node.name);
      if (!node.type) problems.push(`${file}: node "${node.name}" is missing "type"`);
    }
    for (const node of config.nodes) {
      if (node.next && !names.has(node.next)) {
        problems.push(`${file}: node "${node.name}" points to unknown next "${node.next}"`);
      }
    }

    // Bridge pairing. A Bridge binds its partner through `settings.pair`, so a
    // third node whose `next` names that same partner is a second bind of an
    // already-bound node, and WaterWall refuses to load the file:
    //
    //   FATAL Node Map Failure: Node (bridge_a) wanted to bind to (bridge_b)
    //   which is already bounded by bridge_a
    //
    // Nothing earlier in this function catches it, and the failure only shows up
    // when the core starts, so it is checked here instead of on a live server.
    const byName = new Map(config.nodes.map((n) => [n.name, n]));
    for (const node of config.nodes) {
      const target = node.next ? byName.get(node.next) : null;
      if (target && target.type === 'Bridge' && target.settings?.pair === node.name) {
        problems.push(
          `${file}: node "${node.name}" both pairs and points at "${target.name}"; a Bridge pair must not be named again as next`,
        );
      }
    }

    const ends = config.nodes.filter((n) => !n.next);
    if (ends.length === 0) problems.push(`${file}: no chain end found (circular chain?)`);

    // Settings the core rejects at load time with a FATAL, checked here so a
    // bad config is refused by the panel instead of taking the core down.
    for (const node of config.nodes) {
      // Socks5Server needs exactly one honest answer to "how do users
      // authenticate?". `no-auth: false` with no `users` array and no
      // `auth-client-node-name` produces:
      //
      //   FATAL JSON Error: Socks5Server->settings requires
      //   auth-client-node-name unless no-auth is explicitly true
      //
      // and the whole core refuses to start, not just this one listener.
      if (node.type === 'Socks5Server') {
        const s = node.settings || {};
        const hasUsers = Array.isArray(s.users) && s.users.length > 0;
        const hasAuthClient = Boolean(s['auth-client-node-name']);
        if (s['no-auth'] !== true && !hasUsers && !hasAuthClient) {
          problems.push(
            `${file}: Socks5Server «${node.name}» راهی برای احراز هویت ندارد؛ باید no-auth=true باشد یا users پر شود یا auth-client-node-name بیاید، وگرنه هسته بالا نمی‌آید.`,
          );
        }
      }
    }
  }
  return problems;
}

function node(name, type, settings, next) {
  const n = { name, type, version: 0, settings: prune(settings || {}) };
  if (next) n.next = next;
  return n;
}

// --------------------------------------------------------------- variables
// A node config may carry a `variables` block whose entries are referenced as
// bare (unquoted) `$name$` placeholders. WaterWall substitutes them before
// parsing. We emit the same syntax so the generated files stay as readable as
// hand-written ones, and we replicate the substitution here so validation
// works on the real content.

/**
 * Preprocess a node config the way the WaterWall loader does: strip `//`
 * comments outside strings, then substitute `$name$` placeholders.
 */
function preprocessConfig(raw) {
  const problems = [];
  const text = String(raw);

  const stripped = stripComments(text);
  const variables = readVariablesBlock(stripped);
  if (variables === null) problems.push('cannot read the "variables" block');

  const substituted = stripped.replace(/\$([A-Za-z0-9_.-]+)\$/g, (match, name) => {
    if (!variables || !(name in variables)) {
      problems.push(`undefined variable $${name}$`);
      return match;
    }
    return JSON.stringify(variables[name]);
  });

  return { text: substituted, variables: variables || {}, problems };
}

/**
 * Pull the top-level `variables` object out of a config. The rest of the file
 * is not parseable yet (the placeholders are still bare), so this walks the
 * braces directly instead of calling JSON.parse on the whole document.
 */
function readVariablesBlock(text) {
  const key = /"variables"\s*:\s*\{/.exec(text);
  if (!key) return {};
  const start = key.index + key[0].length - 1; // index of the opening brace
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Remove `//` line comments that are not inside a JSON string. */
function stripComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Serialise a node config. When `useVariables` is set, every string of the
 * exact form `@name` is emitted as a bare `$name$` placeholder — the name must
 * be a valid variable token, and the template supplies the matching entry in
 * the config's `variables` block.
 */
function emitConfig(config, { useVariables = false } = {}) {
  if (!useVariables) return `${JSON.stringify(config, null, 2)}\n`;
  return `${unquoteVars(JSON.stringify(config, null, 2))}\n`;
}

/** Turn the string `"@name"` into the bare placeholder `$name$`. */
function unquoteVars(text) {
  return text.replace(/"@([A-Za-z0-9_.-]+)"/g, '$$$1$$');
}

/** Names referenced as `@name` anywhere in a config. */
function usedVariables(config) {
  const found = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === 'object') return Object.values(value).forEach(walk);
    if (typeof value === 'string') {
      const m = /^@([A-Za-z0-9_.-]+)$/.exec(value);
      if (m) found.add(m[1]);
    }
  };
  walk(config);
  return [...found];
}

module.exports = {
  coreJson,
  chainConfig,
  bundleCore,
  validateBundle,
  node,
  emitConfig,
  preprocessConfig,
  stripComments,
  usedVariables,
  DEFAULT_CORE,
};
