/*
 * Print the node layout of every generated bundle, side by side.
 *
 * The live harness must run both halves of a link on one host. That means
 * finding, mechanically, which node listens (what a user connects to) and
 * where the other side delivers traffic (what has to be redirected to the
 * local test service). This prints exactly those two things per template so
 * the remapping table can be written from evidence, not from memory.
 *
 *   node test/live/dump-nodes.js [templateId]
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const templates = require('../../lib/templates');
const { buildBundle } = require('../../lib/build');
const { Store } = require('../../lib/store');
const { preprocessConfig } = require('../../lib/generator');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwlive-'));
const store = new Store(tmp);
store.addServer({ id: 'srv-iran', name: 'Iran', role: 'iran', host: '10.0.0.1' });
store.addServer({ id: 'srv-foreign', name: 'Foreign', role: 'foreign', host: '198.51.100.7' });

const only = process.argv[2];

function portish(settings) {
  const out = [];
  for (const [k, v] of Object.entries(settings || {})) {
    if (/port|address|host|domain|path|sni|bytes/i.test(k) && typeof v !== 'object') out.push(`${k}=${v}`);
  }
  return out.join(' ');
}

for (const tpl of templates.ALL) {
  if (only && tpl.id !== only) continue;
  let tunnel = store.addTunnel({ name: 'probe', template: tpl.id, options: {} });
  let res = buildBundle(store, tunnel);
  if (res.optionsPatch) {
    tunnel = store.updateTunnel(tunnel.id, { options: { ...tunnel.options, ...res.optionsPatch } });
    res = buildBundle(store, tunnel);
  }
  console.log(`\n########## ${tpl.id} ##########`);
  for (const side of ['iran', 'foreign']) {
    const files = res.bundles[side];
    if (!files) {
      console.log(`  ${side}: (no bundle)`);
      continue;
    }
    for (const [file, text] of Object.entries(files)) {
      if (!file.startsWith('configs/')) continue;
      const pre = preprocessConfig(text);
      if (pre.problems.length) {
        console.log(`  ${side}/${file}: PREPROCESS PROBLEMS ${pre.problems.join('; ')}`);
        continue;
      }
      const cfg = JSON.parse(pre.text);
      const nodes = cfg.configs || cfg.nodes || [];
      console.log(`  ${side}/${file}: ${nodes.length} nodes`);
      for (const n of nodes) {
        console.log(`      ${String(n.type).padEnd(26)} ${portish(n.settings)}`);
      }
    }
  }
}
