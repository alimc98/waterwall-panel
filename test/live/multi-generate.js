'use strict';

/**
 * Bundles for the multi-exit live test.
 *
 * One Iran entry, two exits, all on the harness bridge:
 *
 *   wwiran      10.200.0.2   entry (users + reverse links, whitelist both exits)
 *   wwforeign   10.200.0.3   exit A -> 10.200.0.1:9001 (TCP echo)
 *   wwforeign2  10.200.0.4   exit B -> 10.200.0.1:9002 (HTTP)
 *
 * The two exits are the *same* tunnel with one difference: which local service
 * they forward to. That is what lets the probe attribute each connection to an
 * exit and prove the ReverseServer pool actually uses both of them. In a real
 * deployment both exits run the same bundle (their own local service listens on
 * the same port on each box).
 *
 *   node test/live/multi-generate.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const templates = require('../../lib/templates');
const { buildBundle, resolveOptions } = require('../../lib/build');
const { Store } = require('../../lib/store');

const OUT = path.join(__dirname, 'out-multi');
const IRAN_HOST = '10.200.0.2';
const EXIT_A = '10.200.0.3';
const EXIT_B = '10.200.0.4';
const SVC_HOST = '10.200.0.1';
const ECHO_PORT = 9001;
const HTTP_PORT = 9002;
const ENTRY_PORT = 9443;

function writeSide(name, files) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(path.join(dir, 'log'), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

function main() {
  const tpl = templates.get('reverse-reality');
  if (!tpl) throw new Error('reverse-reality is missing from the catalog');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwmulti-'));
  const store = new Store(dataDir);
  store.addServer({ id: 'srv-iran', name: 'Iran', role: 'iran', host: IRAN_HOST });
  store.addServer({ id: 'srv-exit-a', name: 'Exit A', role: 'foreign', host: EXIT_A });
  store.addServer({ id: 'srv-exit-b', name: 'Exit B', role: 'foreign', host: EXIT_B });

  // One set of resolved options for both exits: the Reality password (and every
  // other secret) has to be identical on the entry and on every exit.
  const options = resolveOptions('reverse-reality', {
    userPort: ENTRY_PORT,
    reversePort: ENTRY_PORT,
    samePort: true,
    listenAddress: '0.0.0.0',
    localServiceAddress: SVC_HOST,
    finalPort: ECHO_PORT,
    useVariables: true,
  });

  const tunnel = store.addTunnel({
    name: 'multi-exit-live',
    template: 'reverse-reality',
    targetServers: { iran: 'srv-iran', foreign: ['srv-exit-a', 'srv-exit-b'] },
    options,
  });

  const exitA = buildBundle(store, tunnel);
  if (!exitA.ok) throw new Error(`exit A build failed: ${exitA.problems.join('; ')}`);
  if (!exitA.options.foreignHosts.includes(EXIT_A) || !exitA.options.foreignHosts.includes(EXIT_B)) {
    throw new Error(`both exits must be whitelisted, got ${JSON.stringify(exitA.options.foreignHosts)}`);
  }

  const withHttp = store.updateTunnel(tunnel.id, { options: { ...options, finalPort: HTTP_PORT } });
  const exitB = buildBundle(store, withHttp);
  if (!exitB.ok) throw new Error(`exit B build failed: ${exitB.problems.join('; ')}`);

  fs.rmSync(OUT, { recursive: true, force: true });
  writeSide('iran', exitA.bundles.iran);
  writeSide('exit-a', exitA.bundles.foreign);
  writeSide('exit-b', exitB.bundles.foreign);

  const plan = {
    id: 'multi-exit',
    titleFa: 'چند سرور خارجی روی یک ورودی (تقسیم بار + فیلور)',
    entry: { host: IRAN_HOST, port: ENTRY_PORT },
    exits: [
      { side: 'a', namespace: 'wwforeign', host: EXIT_A, service: `tcp-echo:${ECHO_PORT}` },
      { side: 'b', namespace: 'wwforeign2', host: EXIT_B, service: `http:${HTTP_PORT}` },
    ],
    probes: 24,
  };
  fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify(plan, null, 2));

  console.log(JSON.stringify(plan, null, 1));
  console.log(`\nwrote ${OUT}`);
}

main();
