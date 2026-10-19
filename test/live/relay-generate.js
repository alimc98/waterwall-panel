'use strict';

/**
 * Bundles for the three-hop relay live test.
 *
 *   wwiran      10.200.0.2   entry; users connect to :9443
 *   wwrelay     10.200.0.4   middle; Iran leg :9443, exit backhaul :9444
 *   wwforeign   10.200.0.3   exit A -> 10.200.0.1:9001 (TCP echo)
 *   wwforeign2  10.200.0.5   exit B -> 10.200.0.1:9002 (HTTP)
 *
 * Both exits run the same tunnel with one difference: the local service they
 * forward to. That makes each user connection attributable to an exit and
 * proves the ReverseServer pool on the relay actually spreads the load.
 *
 *   node test/live/relay-generate.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const templates = require('../../lib/templates');
const { buildBundle, resolveOptions } = require('../../lib/build');
const { Store } = require('../../lib/store');

const OUT = path.join(__dirname, 'out-relay');
const IRAN_HOST = '10.200.0.2';
const RELAY_HOST = '10.200.0.4';
const EXIT_A = '10.200.0.3';
const EXIT_B = '10.200.0.5';
const SVC_HOST = '10.200.0.1';
const ECHO_PORT = 9001;
const HTTP_PORT = 9002;
const ENTRY_PORT = 9443;
const BACKHAUL_PORT = 9444;

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
  const tpl = templates.get('relay-reality');
  if (!tpl) throw new Error('relay-reality is missing from the catalog');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwrelay-'));
  const store = new Store(dataDir);
  store.addServer({ id: 'srv-iran', name: 'Iran', role: 'iran', host: IRAN_HOST });
  store.addServer({ id: 'srv-relay', name: 'Relay', role: 'relay', host: RELAY_HOST });
  store.addServer({ id: 'srv-exit-a', name: 'Exit A', role: 'foreign', host: EXIT_A });
  store.addServer({ id: 'srv-exit-b', name: 'Exit B', role: 'foreign', host: EXIT_B });

  // One set of secrets for all three sides. The two exits differ only in the
  // local service port, exactly like a real deployment with two exit boxes.
  const options = resolveOptions('relay-reality', {
    userPort: ENTRY_PORT,
    relayPort: ENTRY_PORT,
    backhaulPort: BACKHAUL_PORT,
    listenAddress: '0.0.0.0',
    relayListenAddress: '0.0.0.0',
    localServiceAddress: SVC_HOST,
    finalPort: ECHO_PORT,
    // The harness runs a local HTTPS decoy on the bridge instead of dialing a
    // real site, so this test works even when the test box has no outbound
    // internet or DNS. The generated cert is for example.com.
    camouflageHost: 'example.com',
    camouflageIp: SVC_HOST,
    camouflagePort: 9445,
    realitySni: 'example.com',
    realityVerify: false,
    // Keep the production default of two workers. The ReverseServer keeps a
    // waiting list per worker and pairs across workers; a one-worker test is
    // not representative of the default deployment.
    _core: { workers: 2, ramProfile: 'minimal' },
    useVariables: true,
  });

  const tunnel = store.addTunnel({
    name: 'relay-live',
    template: 'relay-reality',
    targetServers: {
      iran: 'srv-iran',
      relay: 'srv-relay',
      foreign: ['srv-exit-a', 'srv-exit-b'],
    },
    options,
  });

  const exitA = buildBundle(store, tunnel);
  if (!exitA.ok) throw new Error(`exit A build failed: ${exitA.problems.join('; ')}`);
  if (!exitA.options.foreignHosts.includes(EXIT_A) || !exitA.options.foreignHosts.includes(EXIT_B)) {
    throw new Error(`both exits must be whitelisted, got ${JSON.stringify(exitA.options.foreignHosts)}`);
  }
  if (!tpl.sides.includes('relay') || !exitA.bundles.relay) {
    throw new Error('the relay bundle is missing');
  }

  const withHttp = store.updateTunnel(tunnel.id, { options: { ...options, finalPort: HTTP_PORT } });
  const exitB = buildBundle(store, withHttp);
  if (!exitB.ok) throw new Error(`exit B build failed: ${exitB.problems.join('; ')}`);

  fs.rmSync(OUT, { recursive: true, force: true });
  writeSide('iran', exitA.bundles.iran);
  writeSide('relay', exitA.bundles.relay);
  writeSide('exit-a', exitA.bundles.foreign);
  writeSide('exit-b', exitB.bundles.foreign);

  const plan = {
    id: 'relay-reality',
    titleFa: 'زنجیرهٔ سه‌سروری ایران → رله → خارج (چند خروجی)',
    entry: { host: IRAN_HOST, port: ENTRY_PORT },
    relay: { host: RELAY_HOST, port: ENTRY_PORT, backhaulPort: BACKHAUL_PORT },
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
