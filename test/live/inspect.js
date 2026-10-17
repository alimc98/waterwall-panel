/*
 * Print every node's full settings for one template (both sides), plus the
 * list of files the bundle contains.
 *
 *   node test/live/inspect.js vless-tls
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
store.addServer({ id: 'srv-iran', name: 'Iran', role: 'iran', host: '10.200.0.2' });
store.addServer({ id: 'srv-foreign', name: 'Foreign', role: 'foreign', host: '10.200.0.3' });

for (const tplId of process.argv.slice(2)) {
  const tpl = templates.get(tplId);
  if (!tpl) {
    console.log(`!! no such template: ${tplId}`);
    continue;
  }
  let tunnel = store.addTunnel({ name: 'probe', template: tplId, options: {} });
  let res = buildBundle(store, tunnel);
  if (res.optionsPatch) {
    tunnel = store.updateTunnel(tunnel.id, { options: { ...tunnel.options, ...res.optionsPatch } });
    res = buildBundle(store, tunnel);
  }
  console.log(`\n########## ${tplId} ##########`);
  for (const side of ['iran', 'foreign']) {
    const files = res.bundles[side];
    if (!files) continue;
    console.log(`  --- ${side}: ${Object.keys(files).join(', ')}`);
    for (const [file, text] of Object.entries(files)) {
      if (!file.startsWith('configs/')) {
        console.log(`      [${file}] ${String(text).split('\n')[0].slice(0, 90)}`);
        continue;
      }
      const pre = preprocessConfig(text);
      const cfg = JSON.parse(pre.text);
      for (const n of cfg.nodes) {
        console.log(`      ${n.name} : ${n.type} ${JSON.stringify(n.settings)}`);
        if (n.next) console.log(`        -> ${n.next}`);
      }
    }
  }
}
