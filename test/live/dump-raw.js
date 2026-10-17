'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const templates = require('../../lib/templates');
const { buildBundle } = require('../../lib/build');
const { Store } = require('../../lib/store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwlive-'));
const store = new Store(tmp);
store.addServer({ id: 'srv-iran', name: 'Iran', role: 'iran', host: '10.0.0.1' });
store.addServer({ id: 'srv-foreign', name: 'Foreign', role: 'foreign', host: '198.51.100.7' });

const tplId = process.argv[2] || 'tcp-forward';
let tunnel = store.addTunnel({ name: 'probe', template: tplId, options: {} });
let res = buildBundle(store, tunnel);
if (res.optionsPatch) {
  tunnel = store.updateTunnel(tunnel.id, { options: { ...tunnel.options, ...res.optionsPatch } });
  res = buildBundle(store, tunnel);
}
console.log('problems:', JSON.stringify(res.problems));
console.log('options:', JSON.stringify(res.options, null, 2));
for (const side of ['iran', 'foreign']) {
  for (const [file, text] of Object.entries(res.bundles[side] || {})) {
    console.log(`\n===== ${side}/${file} =====`);
    console.log(text);
  }
}
