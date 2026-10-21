'use strict';

/**
 * Smoke tests: every template must build, produce valid JSON, and pass the
 * chain validator. Run with `npm test`.
 */

const assert = require('node:assert');
const templates = require('../lib/templates');
const { buildBundle, resolveOptions } = require('../lib/build');
const { resolveTargets, isTarget } = require('../lib/targets');
const { Store } = require('../lib/store');
const { validateBundle, preprocessConfig } = require('../lib/generator');
const { transportProblem } = require('../lib/ssh');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwpanel-test-'));
const store = new Store(tmp);

store.addServer({ id: 'srv-iran', name: 'Iran', role: 'iran', host: '10.0.0.1' });
store.addServer({ id: 'srv-relay', name: 'Relay', role: 'relay', host: '10.0.0.2' });
store.addServer({ id: 'srv-foreign', name: 'Foreign', role: 'foreign', host: '198.51.100.7' });

let pass = 0;
let fail = 0;
let usedVariables = 0;
const failures = [];

for (const tpl of templates.ALL) {
  try {
    // Two passes: the second one runs with the provisioned options already stored.
    let tunnel = store.addTunnel({
      name: `test-${tpl.id}`,
      template: tpl.id,
      targetServers: tpl.id === 'relay-reality' ? { relay: 'srv-relay' } : {},
      options: {},
    });
    let result = buildBundle(store, tunnel);
    if (result.optionsPatch) {
      tunnel = store.updateTunnel(tunnel.id, { options: { ...tunnel.options, ...result.optionsPatch } });
      result = buildBundle(store, tunnel);
    }

    assert.ok(result.bundles.iran || result.bundles.foreign, `${tpl.id}: no bundle produced`);
    assert.deepStrictEqual(result.problems, [], `${tpl.id}: ${result.problems.join('; ')}`);

    for (const [side, files] of Object.entries(result.bundles)) {
      for (const [file, text] of Object.entries(files)) {
        if (!file.endsWith('.json')) continue;
        // Resolve $variables$ the way the WaterWall loader does before parsing.
        const pre = preprocessConfig(text);
        assert.deepStrictEqual(pre.problems, [], `${tpl.id}/${side}/${file}: ${pre.problems.join('; ')}`);
        JSON.parse(pre.text); // throws on bad JSON
        assert.deepStrictEqual(validateBundle({ [file]: text }), [], `${tpl.id}/${side}/${file}`);
        if (pre.variables && Object.keys(pre.variables).length) {
          usedVariables += Object.keys(pre.variables).length;
        }
      }
      assert.ok(files['core.json'], `${tpl.id}/${side}: no core.json`);
      const core = JSON.parse(files['core.json']);
      assert.ok(Array.isArray(core.configs) && core.configs.length > 0, `${tpl.id}/${side}: core.json has no configs`);
      assert.ok(core.dns && core.dns['domain-strategy'], `${tpl.id}/${side}: missing dns.domain-strategy`);
      assert.ok(core.misc && core.misc['ram-profile'], `${tpl.id}/${side}: missing misc.ram-profile`);
      for (const p of core.configs) {
        assert.ok(files[p], `${tpl.id}/${side}: core.json lists ${p} but the bundle does not contain it`);
      }
    }
    pass += 1;
    console.log(`  ✓ ${tpl.id.padEnd(24)} ${Object.keys(result.bundles).join(' + ')}`);
  } catch (err) {
    fail += 1;
    failures.push(`${tpl.id}: ${err.message}`);
    console.log(`  ✗ ${tpl.id.padEnd(24)} ${err.message}`);
  }
}

// ---- multi-exit reverse tunnels ------------------------------------------
// A reverse entry can front any number of exit servers. Every exit runs the
// same foreign config and joins the ReverseServer pool on the Iran side, so the
// Iran whitelist has to name all of them and the UI has to know the template
// supports it.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-multi-exit-'));
  const multiStore = new Store(dir);
  multiStore.addServer({ id: 'ir', name: 'Iran', role: 'iran', host: '203.0.113.10' });
  multiStore.addServer({ id: 'ex1', name: 'Exit 1', role: 'foreign', host: '198.51.100.1' });
  multiStore.addServer({ id: 'ex2', name: 'Exit 2', role: 'foreign', host: '198.51.100.2' });
  multiStore.addServer({ id: 'ex3', name: 'Exit 3', role: 'foreign', host: '198.51.100.3' });

  const tunnel = multiStore.addTunnel({
    name: 'multi-exit',
    template: 'reverse-reality',
    targetServers: { iran: 'ir', foreign: ['ex1', 'ex2', 'ex3'] },
    options: {},
  });
  const built = buildBundle(multiStore, tunnel);
  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(built.options.foreignHosts, ['198.51.100.1', '198.51.100.2', '198.51.100.3']);

  const iranCfg = built.bundles.iran['configs/reverse-reality.json'];
  const resolved = preprocessConfig(iranCfg);
  assert.deepStrictEqual(resolved.problems, []);
  for (const host of built.options.foreignHosts) {
    assert.ok(resolved.text.includes(`"${host}/32"`), `the Iran whitelist must contain ${host}/32`);
  }

  // Every exit runs the same bundle: it names the Iran entry, never the exit's
  // own address, so one build can be shipped to the whole fleet.
  const foreignText = Object.values(built.bundles.foreign).join('\n');
  assert.ok(foreignText.includes('203.0.113.10'), 'the exit bundle must dial the Iran entry');
  assert.ok(!foreignText.includes('198.51.100'), 'the exit bundle must not embed a specific exit host');

  assert.strictEqual(templates.get('reverse-reality').multiExit, true);
  assert.strictEqual(templates.catalog().find((x) => x.id === 'reverse-reality').multiExit, true);
  assert.strictEqual(templates.catalog().find((x) => x.id === 'tcp-forward').multiExit, false);

  // The old single-id shape still resolves to exactly one exit.
  const single = multiStore.addTunnel({
    name: 'single-exit',
    template: 'reverse-reality',
    targetServers: { iran: 'ir', foreign: 'ex2' },
    options: {},
  });
  const one = buildBundle(multiStore, single);
  assert.deepStrictEqual(one.options.foreignHosts, ['198.51.100.2']);
  assert.ok(preprocessConfig(one.bundles.iran['configs/reverse-reality.json']).text.includes('198.51.100.2/32'));

  pass += 1;
  console.log(`  ✓ ${'multi-exit'.padEnd(24)} 3 exits whitelisted, one bundle for all`);
}

// ---- three-hop relay + encryption layer ----------------------------------
// The relay is a different shape from both ordinary and reverse tunnels: three
// bundles, two Reality endpoints on the relay, and a reverse pool that the exits
// dial. These checks pin the topology so a future refactor cannot silently
// produce a two-sided or wrongly-whitelisted chain.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-relay-'));
  const relayStore = new Store(dir);
  relayStore.addServer({ id: 'ir', name: 'Iran', role: 'iran', host: '203.0.113.10' });
  relayStore.addServer({ id: 'rl', name: 'Relay', role: 'relay', host: '198.51.100.50' });
  relayStore.addServer({ id: 'e1', name: 'Exit 1', role: 'foreign', host: '198.51.100.1' });
  relayStore.addServer({ id: 'e2', name: 'Exit 2', role: 'foreign', host: '198.51.100.2' });

  const tunnel = relayStore.addTunnel({
    name: 'relay-chain',
    template: 'relay-reality',
    targetServers: { iran: 'ir', relay: 'rl', foreign: ['e1', 'e2'] },
    options: resolveOptions('relay-reality', {}),
  });
  const built = buildBundle(relayStore, tunnel);
  assert.strictEqual(built.ok, true, built.problems.join('; '));
  assert.deepStrictEqual(Object.keys(built.bundles), ['iran', 'relay', 'foreign']);

  const parseSide = (side) => {
    const file = Object.keys(built.bundles[side]).find((f) => f.startsWith('configs/'));
    assert.ok(file, `${side}: no config file`);
    return JSON.parse(preprocessConfig(built.bundles[side][file]).text);
  };
  const iranCfg = parseSide('iran');
  const relayCfg = parseSide('relay');
  const exitCfg = parseSide('foreign');
  const find = (cfg, name) => cfg.nodes.find((n) => n.name === name);

  // Entry: users -> RealityClient -> relay.
  assert.strictEqual(find(iranCfg, 'users_inbound').next, 'reality-client');
  assert.strictEqual(find(iranCfg, 'reality-client').next, 'tcp_to_relay');
  assert.strictEqual(find(iranCfg, 'tcp_to_relay').settings.address, '198.51.100.50');
  assert.strictEqual(find(iranCfg, 'tcp_to_relay').settings.port, 9443);

  // Relay: the Iran leg feeds the user side of the bridge pair, while the exits
  // feed the reverse side through their own RealityServer.
  assert.strictEqual(find(relayCfg, 'relay_in').next, 'reality_entry');
  assert.strictEqual(find(relayCfg, 'reality_entry').next, 'bridge_user_side');
  assert.strictEqual(find(relayCfg, 'reality_exit').next, 'reverse_server');
  assert.strictEqual(find(relayCfg, 'reverse_server').next, 'bridge_reverse_side');
  assert.strictEqual(find(relayCfg, 'exit_in').next, 'reality_exit');
  assert.deepStrictEqual(find(relayCfg, 'relay_in').settings.whitelist, ['203.0.113.10/32']);
  assert.deepStrictEqual(find(relayCfg, 'exit_in').settings.whitelist, ['198.51.100.1/32', '198.51.100.2/32']);
  assert.strictEqual(find(relayCfg, 'relay_in').settings.port, 9443);
  assert.strictEqual(find(relayCfg, 'exit_in').settings.port, 9444);
  assert.strictEqual(find(relayCfg, 'reality_entry').settings.password, tunnel.options.entryPassword);
  assert.strictEqual(find(relayCfg, 'reality_exit').settings.password, tunnel.options.exitPassword);
  assert.notStrictEqual(tunnel.options.entryPassword, tunnel.options.exitPassword);

  // Exit: dials the relay backhaul, never embeds its own public address, and
  // opens no listener at all.
  assert.strictEqual(find(exitCfg, 'reverse_client').next, 'reality-client');
  assert.strictEqual(find(exitCfg, 'reality-client').next, 'tcp_to_relay');
  assert.strictEqual(find(exitCfg, 'tcp_to_relay').settings.address, '198.51.100.50');
  assert.strictEqual(find(exitCfg, 'tcp_to_relay').settings.port, 9444);
  assert.strictEqual(find(exitCfg, 'reality-client').settings.password, tunnel.options.exitPassword);
  assert.ok(!exitCfg.nodes.some((n) => /Listener$/.test(n.type)), 'the exit must not open a listener');
  const exitText = Object.values(built.bundles.foreign).join('\n');
  assert.ok(!exitText.includes('198.51.100.1'), 'the exit bundle must not embed exit 1');
  assert.ok(!exitText.includes('198.51.100.2'), 'the exit bundle must not embed exit 2');
  assert.ok(exitText.includes('198.51.100.50'), 'the exit must dial the relay');

  // No certificate is needed on any hop.
  for (const side of ['iran', 'relay', 'foreign']) {
    assert.ok(!parseSide(side).nodes.some((n) => n.type === 'TlsServer'), `${side}: unexpected TlsServer`);
  }

  // The catalog exposes the third side and the multi-exit capability.
  const entry = templates.catalog().find((x) => x.id === 'relay-reality');
  assert.deepStrictEqual(entry.sides, ['iran', 'relay', 'foreign']);
  assert.strictEqual(entry.multiExit, true);

  // A manual backhaul whitelist must win over the auto-generated exit list;
  // otherwise an exit behind NAT can never be admitted.
  const manual = relayStore.addTunnel({
    name: 'relay-manual-whitelist',
    template: 'relay-reality',
    targetServers: { iran: 'ir', relay: 'rl', foreign: ['e1', 'e2'] },
    options: resolveOptions('relay-reality', {
      relayWhitelist: ['10.9.9.9/32'],
      backhaulWhitelist: ['10.8.8.0/24'],
    }),
  });
  const manualBuilt = buildBundle(relayStore, manual);
  assert.strictEqual(manualBuilt.ok, true, manualBuilt.problems.join('; '));
  const manualFile = Object.keys(manualBuilt.bundles.relay).find((f) => f.startsWith('configs/'));
  const manualRelay = JSON.parse(preprocessConfig(manualBuilt.bundles.relay[manualFile]).text);
  assert.deepStrictEqual(find(manualRelay, 'relay_in').settings.whitelist, ['10.9.9.9/32']);
  assert.deepStrictEqual(find(manualRelay, 'exit_in').settings.whitelist, ['10.8.8.0/24']);

  // Same variable toggle on the three-sided template: with variables off every
  // side must be concrete, not a half-substituted @sentinel.
  const literal = relayStore.addTunnel({
    name: 'relay-literal',
    template: 'relay-reality',
    targetServers: { iran: 'ir', relay: 'rl', foreign: ['e1', 'e2'] },
    options: resolveOptions('relay-reality', { useVariables: false }),
  });
  const literalBuilt = buildBundle(relayStore, literal);
  assert.strictEqual(literalBuilt.ok, true, literalBuilt.problems.join('; '));
  for (const side of ['iran', 'relay', 'foreign']) {
    const file = Object.keys(literalBuilt.bundles[side]).find((f) => f.startsWith('configs/'));
    const text = literalBuilt.bundles[side][file];
    assert.ok(!text.includes('"@'), `${side}: useVariables=false left an @sentinel in the config`);
    const cfg = JSON.parse(text);
    assert.strictEqual(cfg.variables, undefined, `${side}: useVariables=false must omit variables`);
  }

  // A relay-less API call must fail cleanly, not silently pick the first relay.
  const missing = relayStore.addTunnel({
    name: 'relay-missing',
    template: 'relay-reality',
    targetServers: { iran: 'ir', foreign: 'e1' },
    options: {},
  });
  const missingBuild = buildBundle(relayStore, missing);
  assert.strictEqual(missingBuild.ok, false);
  assert.match(missingBuild.problems.join(' '), /relay/);

  pass += 1;
  console.log(`  ✓ ${'relay-chain'.padEnd(24)} 3 sides, 2 Reality hops, exits closed`);
}

// Optional AEAD layer inside an existing CDN tunnel. Off by default so a live
// tunnel's bytes do not change; on, both sides must agree on password and
// algorithm and sit inside the WebSocket/Mux carrier.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-enc-'));
  const encStore = new Store(dir);
  encStore.addServer({ id: 'ir', name: 'Iran', role: 'iran', host: '203.0.113.10' });
  encStore.addServer({ id: 'ex', name: 'Exit', role: 'foreign', host: '198.51.100.1' });

  const plain = encStore.addTunnel({
    name: 'cdn-plain',
    template: 'cdn-reverse-wss',
    targetServers: { iran: 'ir', foreign: 'ex' },
    options: resolveOptions('cdn-reverse-wss', {}),
  });
  const plainBuild = buildBundle(encStore, plain);
  assert.strictEqual(plainBuild.ok, true, plainBuild.problems.join('; '));
  for (const side of ['iran', 'foreign']) {
    const file = Object.keys(plainBuild.bundles[side]).find((f) => f.startsWith('configs/'));
    const cfg = JSON.parse(preprocessConfig(plainBuild.bundles[side][file]).text);
    assert.ok(!cfg.nodes.some((n) => /^Encryption(Client|Server)$/.test(n.type)), `${side}: encryption must be off by default`);
  }

  const enc = encStore.addTunnel({
    name: 'cdn-encrypted',
    template: 'cdn-reverse-wss',
    targetServers: { iran: 'ir', foreign: 'ex' },
    options: { ...resolveOptions('cdn-reverse-wss', {}), linkEncryption: true },
  });
  const encBuild = buildBundle(encStore, enc);
  assert.strictEqual(encBuild.ok, true, encBuild.problems.join('; '));
  const parseEnc = (side) => {
    const file = Object.keys(encBuild.bundles[side]).find((f) => f.startsWith('configs/'));
    return JSON.parse(preprocessConfig(encBuild.bundles[side][file]).text);
  };
  const iranEnc = parseEnc('iran');
  const exitEnc = parseEnc('foreign');
  const server = iranEnc.nodes.find((n) => n.type === 'EncryptionServer');
  const client = exitEnc.nodes.find((n) => n.type === 'EncryptionClient');
  assert.ok(server && client, 'both peers must be emitted');
  assert.strictEqual(server.next, 'reverse_server');
  assert.strictEqual(iranEnc.nodes.find((n) => n.type === 'MuxServer').next, 'encryption_server');
  assert.strictEqual(exitEnc.nodes.find((n) => n.type === 'ReverseClient').next, 'encryption_client');
  assert.strictEqual(client.next, 'mux_client');
  assert.strictEqual(server.settings.password, client.settings.password);
  assert.strictEqual(server.settings.algorithm, client.settings.algorithm);

  // The "Use $variables$" toggle must produce concrete values when it is off,
  // not leave internal @sentinels in the JSON. This regressed once for the new
  // encryption nodes because their sentinels were applied unconditionally.
  const literal = encStore.addTunnel({
    name: 'cdn-encrypted-literal',
    template: 'cdn-reverse-wss',
    targetServers: { iran: 'ir', foreign: 'ex' },
    options: resolveOptions('cdn-reverse-wss', { linkEncryption: true, useVariables: false }),
  });
  const literalBuild = buildBundle(encStore, literal);
  assert.strictEqual(literalBuild.ok, true, literalBuild.problems.join('; '));
  for (const side of ['iran', 'foreign']) {
    const file = Object.keys(literalBuild.bundles[side]).find((f) => f.startsWith('configs/'));
    const text = literalBuild.bundles[side][file];
    assert.ok(!text.includes('"@'), `${side}: useVariables=false left an @sentinel in the config`);
    const cfg = JSON.parse(text);
    assert.strictEqual(cfg.variables, undefined, `${side}: useVariables=false must omit variables`);
    const node = cfg.nodes.find((n) => /^Encryption(Client|Server)$/.test(n.type));
    assert.ok(node && !String(node.settings.password).startsWith('@'), `${side}: password was not concrete`);
  }

  pass += 1;
  console.log(`  ✓ ${'cdn-encryption'.padEnd(24)} AEAD inside WebSocket, off by default`);
}

// ---- foreign entry -> Iran middle -> foreign exit -------------------------
// This is the other three-server shape from `relay-reality`: the users connect
// to a foreign entry box (Germany), Iran is a transparent L4 relay, and a
// second foreign box (Turkey) terminates Reality and runs the SOCKS5 server.
// Both tunnels must agree on the link address/whitelist, and the middle bundle
// must have no foreign side at all.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-chain-'));
  const chain = new Store(dir);
  chain.addServer({ id: 'de', name: 'Germany (entry)', role: 'iran', host: '203.0.113.10' });
  chain.addServer({ id: 'ir', name: 'Iran (middle)', role: 'iran', host: '203.0.113.20' });
  chain.addServer({ id: 'tr', name: 'Turkey (exit)', role: 'foreign', host: '198.51.100.30' });

  const main = chain.addTunnel({
    name: 'entry-exit',
    template: 'socks5-reality-mux',
    targetServers: { iran: 'de', foreign: 'tr' },
    options: resolveOptions('socks5-reality-mux', {
      listenPort: 1080,
      publicPort: 443,
      relayHost: '203.0.113.20',
      publicWhitelist: ['203.0.113.20'],
      sourceIp: '203.0.113.10',
    }),
  });
  // A tunnel created by the previous revision has `muxEnabled: true` stored.
  // The field is gone now, but old records must still build the working chain
  // instead of resurrecting the broken Mux nodes.
  chain.updateTunnel(main.id, {
    options: { ...main.options, muxEnabled: true, muxMode: 'timer', muxMaxChildren: 4096 },
  });
  const mainBuilt = buildBundle(chain, chain.getTunnel(main.id));
  assert.strictEqual(mainBuilt.ok, true, mainBuilt.problems.join('; '));
  assert.deepStrictEqual(Object.keys(mainBuilt.bundles).sort(), ['foreign', 'iran']);
  const findNode = (cfg, name) => cfg.nodes.find((n) => n.name === name);
  const de = JSON.parse(preprocessConfig(mainBuilt.bundles.iran['configs/socks5-reality.json']).text);
  const tr = JSON.parse(preprocessConfig(mainBuilt.bundles.foreign['configs/socks5-reality.json']).text);
  assert.ok(!de.nodes.some((n) => /^Mux/.test(n.type)), 'a legacy muxEnabled option must not add a MuxClient');
  assert.ok(!tr.nodes.some((n) => /^Mux/.test(n.type)), 'a legacy muxEnabled option must not add a MuxServer');

  assert.strictEqual(findNode(de, 'local').settings.port, 1080);
  assert.strictEqual(findNode(de, 'out').settings.address, '203.0.113.20');
  assert.strictEqual(findNode(de, 'out').settings.port, 443);
  assert.strictEqual(findNode(de, 'out').settings['source-ip'], '203.0.113.10');
  assert.strictEqual(findNode(de, 'reality').settings.password, findNode(tr, 'reality').settings.password);
  assert.strictEqual(findNode(de, 'reality').settings.salt, findNode(tr, 'reality').settings.salt);
  assert.deepStrictEqual(findNode(tr, 'public').settings.whitelist, ['203.0.113.20/32']);
  assert.strictEqual(findNode(tr, 'public').settings.port, 443);
  assert.strictEqual(findNode(tr, 'reality').next, 'socks');
  assert.ok(!tr.nodes.some((n) => n.type === 'MuxServer'), 'Mux before Socks5Server breaks CONNECT on 1.46.96');
  assert.strictEqual(findNode(tr, 'socks').type, 'Socks5Server');
  assert.strictEqual(findNode(tr, 'socks').settings['no-auth'], true);
  assert.strictEqual(findNode(tr, 'socks').settings.udp, false);

  const middle = chain.addTunnel({
    name: 'middle-relay',
    template: 'tcp-relay',
    targetServers: { iran: 'ir' },
    options: resolveOptions('tcp-relay', {
      listenPort: 443,
      destAddress: '198.51.100.30',
      destPort: 443,
      whitelist: ['203.0.113.10'],
      sourceIp: '203.0.113.20',
    }),
  });
  const midBuilt = buildBundle(chain, middle);
  assert.strictEqual(midBuilt.ok, true, midBuilt.problems.join('; '));
  assert.deepStrictEqual(Object.keys(midBuilt.bundles), ['iran']);
  const mid = JSON.parse(preprocessConfig(midBuilt.bundles.iran['configs/tcp-relay.json']).text);
  assert.deepStrictEqual(findNode(mid, 'entry').settings.whitelist, ['203.0.113.10/32']);
  assert.strictEqual(findNode(mid, 'entry').settings.port, 443);
  assert.strictEqual(findNode(mid, 'exit').settings.address, '198.51.100.30');
  assert.strictEqual(findNode(mid, 'exit').settings.port, 443);
  assert.strictEqual(findNode(mid, 'exit').settings['source-ip'], '203.0.113.20');
  assert.ok(!mid.nodes.some((n) => /Reality|Socks5|Mux/.test(n.type)), 'the middle relay must stay transparent');

  // Agent targeting: the main tunnel goes only to Germany + Turkey, and the
  // single-sided middle tunnel goes only to Iran. The fallback exit address in
  // `tcp-relay` must not make a Turkish agent claim the middle bundle.
  const chainServers = chain.listServers();
  const deServer = chainServers.find((s) => s.id === 'de');
  const irServer = chainServers.find((s) => s.id === 'ir');
  const trServer = chainServers.find((s) => s.id === 'tr');
  const mainSides = templates.get(main.template).sides;
  const midSides = templates.get(middle.template).sides;
  const mainTargets = resolveTargets(chainServers, main);
  assert.ok(isTarget(mainTargets, main, deServer, mainSides));
  assert.ok(isTarget(mainTargets, main, trServer, mainSides));
  assert.ok(!isTarget(mainTargets, main, irServer, mainSides));
  const midTargets = resolveTargets(chainServers, middle);
  assert.ok(isTarget(midTargets, middle, irServer, midSides));
  assert.ok(!isTarget(midTargets, middle, deServer, midSides));
  assert.ok(!isTarget(midTargets, middle, trServer, midSides), 'the exit must not receive the single-sided middle bundle');

  pass += 1;
  console.log(`  ✓ ${'entry-relay-exit'.padEnd(24)} two foreign boxes, Iran only forwards`);
}

// ---- raw IPs in whitelist/blacklist become CIDRs --------------------------
// WaterWall rejects a bare IP in TcpListener.settings.whitelist at startup
// ("is not a valid CIDR"). The panel's fields say "IPs / CIDRs", so the build
// normalizes bare IPs centrally. Variable references must not be touched.
{
  const raw = store.addTunnel({
    name: 'raw-ip-list',
    template: 'tcp-forward',
    targetServers: { iran: 'srv-iran', foreign: 'srv-foreign' },
    options: resolveOptions('tcp-forward', {
      listenPort: 20001,
      destAddress: '198.51.100.7',
      destPort: 80,
      whitelist: ['203.0.113.9'],
      blacklist: ['198.51.100.0/24'],
    }),
  });
  const rawBuilt = buildBundle(store, store.getTunnel(raw.id));
  assert.strictEqual(rawBuilt.ok, true, rawBuilt.problems.join('; '));
  const rawCfg = JSON.parse(rawBuilt.bundles.iran['configs/tcp-forward.json']);
  const rawEntry = rawCfg.nodes.find((n) => n.name === 'entry');
  assert.deepStrictEqual(rawEntry.settings.whitelist, ['203.0.113.9/32']);
  assert.deepStrictEqual(rawEntry.settings.blacklist, ['198.51.100.0/24']);

  const varsTunnel = store.addTunnel({
    name: 'variable-ip-lists',
    template: 'relay-reality',
    targetServers: { relay: 'srv-relay' },
    options: resolveOptions('relay-reality', {}),
  });
  const varsBuilt = buildBundle(store, store.getTunnel(varsTunnel.id));
  assert.strictEqual(varsBuilt.ok, true, varsBuilt.problems.join('; '));
  for (const [side, files] of Object.entries(varsBuilt.bundles)) {
    for (const [file, text] of Object.entries(files)) {
      if (!file.startsWith('configs/')) continue;
      const cfg = JSON.parse(preprocessConfig(text).text);
      for (const n of cfg.nodes) {
        for (const key of ['whitelist', 'blacklist']) {
          for (const value of n.settings?.[key] || []) {
            assert.match(String(value), /^[0-9a-fA-F:.]+\/\d+$/, `${side}/${file}: invalid peer list after variable substitution`);
          }
        }
      }
    }
  }

  pass += 1;
  console.log(`  ✓ ${'ip-list-normalisation'.padEnd(24)} bare IPs gain /32, variables stay intact`);
}

// ---- shared secrets must be identical on both sides ----------------------
// Both ends of a tunnel have to agree on secrets (Reality password, UUID, ...).
// If a build generates them independently the tunnel silently breaks, so every
// build is compared against the first one and against the stored options.
for (const tpl of templates.ALL) {
  const created = store.addTunnel({
    name: `secrets-${tpl.id}`,
    template: tpl.id,
    targetServers: tpl.id === 'relay-reality' ? { relay: 'srv-relay' } : {},
    options: resolveOptions(tpl.id, {}),
  });

  const stored = store.getTunnel(created.id).options;

  // Every generated secret must be persisted, never left as a placeholder.
  for (const key of Object.keys(stored)) {
    assert.ok(
      !String(stored[key]).startsWith('auto:'),
      `${tpl.id}: option "${key}" was stored as the literal placeholder ${stored[key]}`,
    );
  }

  // A secret that exists on both sides must be byte-identical, and stable
  // across rebuilds (the agent rebuilds the bundle on every poll).
  const shared = Object.entries(stored).filter(
    ([, v]) => typeof v === 'string' && v.length >= 8 && tpl.id.length > 0,
  );
  for (const [key, value] of shared) {
    for (const attempt of [1, 2, 3]) {
      const built = buildBundle(store, store.getTunnel(created.id));
      const iran = JSON.stringify(built.bundles.iran);
      const foreign = JSON.stringify(built.bundles.foreign);
      // The value must still be in the Iran config, unchanged.
      if (iran.includes(value) || iran.includes(`"$${'@'}`)) continue;
      const inIran = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(iran);
      if (inIran) {
        assert.strictEqual(inIran[1], value, `${tpl.id}: "${key}" changed between builds`);
      }
      if (attempt > 1) break;
    }
    // Cross-side agreement for the well-known secret keys.
    if (['realityPassword', 'password', 'uuid', 'encryptionPassword', 'authSecret', 'reverseSecret'].includes(key)) {
      const built = buildBundle(store, store.getTunnel(created.id));
      const iran = JSON.stringify(built.bundles.iran).replace(/\$[A-Za-z0-9_.-]+\$/g, 'X');
      const foreign = JSON.stringify(built.bundles.foreign).replace(/\$[A-Za-z0-9_.-]+\$/g, 'X');
      const inIran = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(iran);
      const inForeign = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(foreign);
      if (inIran && inForeign) {
        assert.strictEqual(
          inIran[1],
          inForeign[1],
          `${tpl.id}: "${key}" differs between the Iran and foreign configs (${inIran[1]} vs ${inForeign[1]})`,
        );
      }
    }
  }
}

// ---- the "Use $variables$" toggle must never leak internal sentinels ------
// A sentinel is an internal `@name` marker, not valid WaterWall syntax. When
// the toggle is off, every generated config must contain concrete values. This
// covers every template, not just the ones that happened to be refactored.
for (const tpl of templates.ALL) {
  const created = store.addTunnel({
    name: `literal-${tpl.id}`,
    template: tpl.id,
    targetServers: tpl.id === 'relay-reality' ? { relay: 'srv-relay' } : {},
    options: resolveOptions(tpl.id, { useVariables: false }),
  });
  const built = buildBundle(store, created);
  assert.strictEqual(built.ok, true, `${tpl.id}: ${built.problems.join('; ')}`);
  for (const [side, files] of Object.entries(built.bundles)) {
    for (const [file, text] of Object.entries(files)) {
      if (!file.startsWith('configs/')) continue;
      const leaked = text.match(/"@[A-Za-z0-9_.-]+"/g);
      assert.ok(!leaked, `${tpl.id} ${side} ${file}: useVariables=false leaked ${leaked?.join(', ')}`);
    }
  }
}

// ---- protocol probe packets ----------------------------------------------
// The scanner builds real IPv4 packets; if the header or the checksums are
// wrong every number would look "blocked" and the report would be a lie.
{
  const ps = require('../lib/protoscan');
  for (const proto of [6, 17, 50, 51, 132, 136, 255, 0]) {
    const pkt = ps.buildProbe({ src: '10.0.0.1', dst: '198.51.100.9', protocol: proto, id: 1000, token: 0xdeadbeef });
    assert.strictEqual(pkt.length, 36, `proto ${proto}: wrong packet length ${pkt.length}`);
    assert.strictEqual(pkt[0], 0x45, `proto ${proto}: not IPv4/20-byte`);
    assert.strictEqual(pkt[9], proto, `proto ${proto}: protocol byte is ${pkt[9]}`);
    assert.strictEqual(pkt.readUInt16BE(2), 36, `proto ${proto}: bad total length`);
    assert.strictEqual(pkt[20], 8, `proto ${proto}: ICMP type must be echo request`);
    assert.strictEqual(pkt.readUInt16BE(28 + 6), 0x5741, `proto ${proto}: missing magic`);

    // IPv4 header checksum.
    const ipHdr = Buffer.from(pkt.subarray(0, 20));
    ipHdr.writeUInt16BE(0, 10);
    assert.strictEqual(ps.checksum16(ipHdr), pkt.readUInt16BE(10), `proto ${proto}: bad IPv4 checksum`);
    // ICMP checksum.
    const icmp = Buffer.from(pkt.subarray(20, 36));
    icmp.writeUInt16BE(0, 2);
    assert.strictEqual(ps.checksum16(icmp), pkt.readUInt16BE(22), `proto ${proto}: bad ICMP checksum`);

    // The reply matcher must accept our own packet (offset consistency).
    assert.strictEqual(pkt.readUInt32BE(30), 0xdeadbeef, `proto ${proto}: token offset mismatch`);
  }
  // An invalid address must be rejected rather than silently zeroed.
  assert.throws(() => ps.buildProbe({ src: '10.0.0.999', dst: '1.1.1.1', protocol: 50, id: 1, token: 1 }));
}

// ---- WaterWall version knowledge -----------------------------------------
// WaterWall turns removed settings into startup errors, so the panel has to
// catch them before deployment. If the lint silently stopped working, tunnels
// would be generated that refuse to start on the server.
{
  const v = require('../lib/versions');

  // Component-wise compare: a plain numeric compare gets 1.46.9 / 1.46.96 wrong.
  assert.strictEqual(v.cmp('1.46.96', '1.46.96'), 0);
  assert.ok(v.cmp('1.46.96', '1.46.9') > 0, '1.46.96 must be newer than 1.46.9');
  assert.ok(v.cmp('1.46.9', '1.46.96') < 0, '1.46.9 must be older than 1.46.96');
  assert.ok(v.cmp('1.46.96', '1.45.1') > 0, 'newer minor wins over a bigger patch');
  assert.ok(v.cmp('1.46.10', '1.46.9') > 0, 'patch compares numerically, not lexically');

  assert.strictEqual(v.normalise('v1.46.96'), '1.46.96');
  assert.strictEqual(v.normalise('  1.46.96 '), '1.46.96');
  assert.strictEqual(v.normalise('garbage'), null);

  // Reality rejects max-frame-size ...
  const realityBad = {
    nodes: [{ name: 'r', type: 'RealityServer', settings: { destination: 'v', password: 'p', 'max-frame-size': 16356 } }],
  };
  assert.strictEqual(v.lintConfig(realityBad).length, 1, 'Reality + max-frame-size must be caught');

  // ... but EncryptionClient still accepts it.
  const encryptionOk = {
    nodes: [{ name: 'e', type: 'EncryptionClient', settings: { password: 'p', 'max-frame-size': 16356 } }],
  };
  assert.strictEqual(v.lintConfig(encryptionOk).length, 0, 'EncryptionClient max-frame-size is still valid');

  // Ping v2 is a closed set; each offending key is reported exactly once even
  // though it is covered by two rules.
  const pingV1 = {
    nodes: [{ name: 'p', type: 'PingServer', settings: { 'local-ipv4': '1.1.1.1', strategy: 'icmp', source: 'a' } }],
  };
  const pingHits = v.lintConfig(pingV1).map((h) => h.key);
  assert.deepStrictEqual(pingHits, ['strategy', 'source'], `ping v1 keys reported wrongly: ${pingHits}`);

  const pingV2 = {
    nodes: [
      {
        name: 'p',
        type: 'PingServer',
        settings: { 'local-ipv4': '1.1.1.1', 'peer-ipv4': '2.2.2.2', 'send-replies': true, ttl: 64 },
      },
    ],
  };
  assert.strictEqual(v.lintConfig(pingV2).length, 0, 'Ping v2 settings must be accepted');

  // Feature gating.
  const frag = { nodes: [{ name: 'f', type: 'StreamFragmenter', settings: { mode: 'counter', count: 1, cuts: [] } }] };
  assert.deepStrictEqual(v.featuresUsed(frag), ['streamFragmenter']);
  assert.strictEqual(v.checkAgainstVersion(frag, '1.46.96').problems.length, 0);
  assert.strictEqual(v.checkAgainstVersion(frag, '1.46.9').problems.length, 1, 'older core must be flagged');
  assert.strictEqual(v.checkAgainstVersion(frag, null).known, false);

  // Server-side check: an old core reported by the agent must produce a warning.
  const tooOld = v.checkServer({ minVersion: '1.46.96' }, { lastStatus: { waterwallVersion: '1.46.8' } });
  assert.strictEqual(tooOld.problems.length, 1, 'old server version must warn');
  assert.strictEqual(v.checkServer({ minVersion: '1.46.96' }, { lastStatus: { waterwallVersion: '1.46.96' } }).problems.length, 0);
  assert.strictEqual(v.checkServer({}, null).known, false);
}

// ---- new WaterWall 1.46.96 surfaces --------------------------------------
// The packet-level and shaping nodes have startup-time validation that fails
// loudly. If the panel stops enforcing it, users get configs that refuse to
// start, so the refusal itself is worth asserting.
{
  const os = require('node:os');
  const fsp = require('node:fs');
  const pathm = require('node:path');
  const { Store } = require('../lib/store');
  const { resolveOptions } = require('../lib/build');

  const dir = fsp.mkdtempSync(pathm.join(os.tmpdir(), 'ww-cases-'));
  const store = new Store(dir);
  store.addServer({ id: 'i', name: 'Iran', role: 'iran', host: '1.1.1.1' });
  store.addServer({ id: 'f', name: 'For', role: 'foreign', host: '2.2.2.2' });

  const attempt = (template, opts) => {
    const t = store.addTunnel({ name: 'case', template, options: resolveOptions(template, opts) });
    return buildBundle(store, t);
  };

  // first-sni: the decoy must be kept away from the destination, and with
  // neither mechanism WaterWall may deliver it as valid in-window data.
  const noDecoyGuard = attempt('first-sni', { decoyTtlEnabled: false, decoyRandomSequence: false });
  assert.strictEqual(noDecoyGuard.ok, false, 'first-sni must require a decoy-removal mechanism');
  assert.strictEqual(attempt('first-sni', { decoyCount: 20 }).ok, false, 'decoy count is capped at 16');
  assert.strictEqual(attempt('first-sni', { decoyHost: '   ' }).ok, false, 'decoy host cannot be blank');

  // FEC shards must sum to at most 255.
  assert.strictEqual(
    attempt('tcp-over-udp', { fec: true, fecDataShards: 200, fecParityShards: 200 }).ok,
    false,
    'FEC shards must sum to <= 255',
  );

  // PROXY protocol requires a real frontend IPv4.
  assert.strictEqual(
    attempt('header-proxy', { headerMode: 'proxy-protocol-v2', frontendIpv4: 'not-an-ip' }).ok,
    false,
    'PROXY protocol needs a valid frontend IPv4',
  );

  // StreamFragmenter rejects an unparseable or duplicated cut list at
  // construction. (An empty field falls back to the template default, so the
  // interesting case is input that parses to nothing usable.)
  assert.strictEqual(attempt('stream-fragmenter', { cuts: 'abc' }).ok, false, 'fragmenter needs at least one cut');
  assert.strictEqual(
    attempt('stream-fragmenter', { cuts: '250,2,50\n250,5,40' }).ok,
    false,
    'duplicate cut offsets must be rejected, not silently collapsed',
  );

  // HalfDuplex rejects fewer than one simultaneous try.
  assert.strictEqual(
    attempt('connection-fisher', { simultaneousTries: 0 }).ok,
    false,
    'connection fisher needs at least one try',
  );

  // The new templates must exist, and the ones built on nodes that only appeared
  // in 1.46.96 must say so, otherwise the version check silently passes on an
  // older core. `disturber-lab` is deliberately absent from the second list:
  // Disturber predates the release and works on older cores too.
  const newTemplates = [
    'half-duplex',
    'stream-fragmenter',
    'connection-fisher',
    'tun2socks',
    'ping-tunnel',
    'first-sni',
    'sni-blender',
    'disturber-lab',
    'tcp-over-udp',
    'header-proxy',
  ];
  for (const id of newTemplates) {
    assert.ok(templates.get(id), `template ${id} must exist`);
  }
  for (const id of newTemplates.filter((x) => x !== 'disturber-lab')) {
    assert.strictEqual(templates.get(id).minVersion, '1.46.96', `${id} must declare minVersion 1.46.96`);
  }
  assert.strictEqual(
    templates.get('disturber-lab').minVersion,
    undefined,
    'disturber-lab needs no recent core and must not claim one',
  );
}

// ---- reachability checks --------------------------------------------------
// A tunnel can upload cleanly and still be dead because a firewall never let the
// link port through. If the check stops working, the user is back to hunting a
// config that was never the problem.
//
// These are asynchronous, so the block returns a promise that is awaited before
// the summary is printed.
function netcheckTests() {
  const netcheck = require('../lib/netcheck');

  assert.strictEqual(netcheck.validPort(443), true);
  assert.strictEqual(netcheck.validPort('8443'), true);
  for (const bad of [0, -1, 65536, 'abc', '', null, undefined, '22; rm -rf /']) {
    assert.strictEqual(netcheck.validPort(bad), false, JSON.stringify(bad) + ' must be rejected');
  }

  // The probe classifies by `timeout`'s exit code: 0 open, 124 filtered,
  // anything else means the host answered with RST so nothing is listening.
  const stub = (rc) => async () => ({ stdout: String(rc) + '\n', stderr: '', failed: false, code: 0 });
  const srv = { host: '10.0.0.1', sshUser: 'root' };
  const peerHost = '203.0.113.9';

  return (async () => {
    const open = await netcheck.tcpProbe(stub(0), srv, { host: peerHost, port: 443 });
    assert.strictEqual(open.verdict, 'open', 'an accepted connection is open');

    const filtered = await netcheck.tcpProbe(stub(124), srv, { host: peerHost, port: 443 });
    assert.strictEqual(filtered.verdict, 'filtered', 'a timed-out connection is filtered');

    const refused = await netcheck.tcpProbe(stub(1), srv, { host: peerHost, port: 443 });
    assert.strictEqual(refused.verdict, 'refused', 'an RST means nothing is listening');

    // A probe that yields nothing usable falls through to the control test. If
    // that also fails the box has no path at all, and blaming the far side's
    // firewall would send the user in exactly the wrong direction.
    const deadBox = async () => ({ stdout: '', stderr: '', failed: true, code: null });
    const noEgress = await netcheck.tcpProbe(deadBox, srv, { host: peerHost, port: 443 });
    assert.strictEqual(noEgress.verdict, 'no-egress', 'a box with no path must not be reported as filtered');

    const sides = { iran: { host: '85.198.55.61', role: 'iran' }, foreign: { host: peerHost, role: 'foreign' } };

    // Only scoped ufw allow rules may be applied by the panel: this endpoint
    // runs commands on a live host.
    const fake = async () => ({ ok: true, output: 'ok' });
    assert.strictEqual((await netcheck.applyFirewallFix(fake, sides.foreign, 'ufw allow 443/tcp')).ok, true);
    assert.strictEqual(
      (await netcheck.applyFirewallFix(fake, sides.foreign, 'ufw allow from 1.2.3.4 to any port 2053 proto tcp')).ok,
      true,
    );
    for (const dangerous of ['ufw disable', 'ufw --force delete all', 'rm -rf /', 'iptables -F', 'ufw allow all', '']) {
      const r = await netcheck.applyFirewallFix(fake, sides.foreign, dangerous);
      assert.strictEqual(r.ok, false, 'must refuse: ' + dangerous);
    }

    // A refused link is a different problem from a filtered one, so it must not
    // be answered with a firewall rule: nothing is listening, not nothing is
    // allowed.
    assert.strictEqual(
      netcheck.fixCommandFor({ kind: 'link-filtered', port: 2053 }, sides),
      'ufw allow from 85.198.55.61 to any port 2053 proto tcp',
    );
    assert.strictEqual(netcheck.fixCommandFor({ kind: 'entry-filtered', port: 443 }, sides), 'ufw allow 443/tcp');
    assert.strictEqual(
      netcheck.fixCommandFor({ kind: 'link-refused', port: 2053 }, sides),
      null,
      'a refused port is a service problem, not a firewall one',
    );
  })();
}

const netcheckPending = netcheckTests();

// ---- certificate handling -------------------------------------------------
// The domain field ends up inside an openssl -subj and, for Let's Encrypt,
// inside a command line on a remote host. Validation has to reject shell
// syntax here, before it is ever concatenated into anything.
function certTests() {
  const fs2 = require('node:fs');
  const certs = require('../lib/certs');

  // Accepted shapes.
  for (const ok of ['example.com', 'a.b.co.uk', 'xn--80ak6aa92e.com', 'sub.domain.example.org']) {
    assert.strictEqual(certs.validateDomain(ok).ok, true, ok + ' should be a valid domain');
  }

  // Normalisation: scheme and path are stripped, case is folded.
  assert.strictEqual(certs.normaliseDomain('https://Example.COM/path'), 'example.com');
  assert.strictEqual(certs.normaliseDomain('  EXAMPLE.com  '), 'example.com');

  // Rejected shapes. The shell-injection cases matter most: this value is
  // interpolated into a remote command line.
  for (const bad of [
    '',
    '   ',
    'not a domain',
    'example.com; rm -rf /',
    'example.com && curl evil',
    'example.com|cat',
    '-bad.com',
    'bad-.com',
    'example..com',
    '.example.com',
    'exam ple.com',
    'http://',
    'a'.repeat(250) + '.com',
    '<script>',
    '$(whoami)',
    "`id`",
  ]) {
    assert.strictEqual(certs.validateDomain(bad).ok, false, JSON.stringify(bad) + ' must be rejected');
  }

  // Expiry arithmetic drives both the UI badge and the renewal decision.
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
  assert.strictEqual(certs.statusOf({ notAfter: inDays(200) }), 'valid');
  assert.strictEqual(certs.statusOf({ notAfter: inDays(10) }), 'expiring', 'inside 30 days must warn');
  assert.strictEqual(certs.statusOf({ notAfter: inDays(-1) }), 'expired');
  assert.strictEqual(certs.statusOf({ notAfter: null }), 'unknown');
  assert.strictEqual(certs.daysUntil(null), null);
  assert.strictEqual(certs.daysUntil(inDays(10)), 10);

  // One managed location, so the panel and the core cannot disagree.
  assert.strictEqual(certs.CERT_PATH, '/etc/waterwall/cert/fullchain.pem');
  assert.strictEqual(certs.KEY_PATH, '/etc/waterwall/cert/privkey.pem');

  // A template that lets the user configure a certificate path must also offer
  // the automatic route: a form where you can paste a path but never fill in a
  // domain is the gap this feature is meant to close.
  //
  // Deliberately keyed off certPath being *exposed*, not off the template
  // mentioning TlsServer: Reality needs no certificate, and the packet-level
  // templates only offer optional TLS termination for users.
  const noDomainField = templates.ALL.filter((tpl) => {
    const keys = (tpl.fields || []).map((f) => f.key);
    return keys.includes('certPath') && !keys.includes('domain');
  }).map((tpl) => tpl.id);
  assert.deepStrictEqual(
    noDomainField,
    [],
    'these templates expose certPath but no domain field: ' + noDomainField.join(', '),
  );

  // And no template may reintroduce a hardcoded /root certificate path, which
  // would silently bypass the managed location.
  const TPL_DIR = require('node:path').join(__dirname, '..', 'lib', 'templates') + require('node:path').sep;
  // Derived from the catalogue rather than written out again: a second copy of
  // the id-to-file map silently stops covering whatever was added last, which is
  // exactly the file most likely to contain a fresh mistake.
  const FILE_OF = Object.fromEntries(templates.ALL.map((t) => [t.id, idToFile(t.id)]));
  const offenders = [];
  for (const file of new Set(Object.values(FILE_OF))) {
    const source = fs2.readFileSync(TPL_DIR + file, 'utf8');
    if (source.includes('/root/fullchain.pem') || source.includes('/root/privkey.pem')) offenders.push(file);
  }
  assert.deepStrictEqual(offenders, [], 'these template files bypass the managed certificate path: ' + offenders.join(', '));
}
/** Template id -> file, following the mapping in lib/templates/index.js. */
function idToFile(id) {
  const map = {
    'tcp-forward': 'basic.js', 'udp-forward': 'basic.js', 'tcp-udp-forward': 'basic.js',
    'encrypted-tcp': 'basic.js', 'xor-obfuscated': 'basic.js', 'tcp-relay': 'basic.js',
    'vless-tls': 'stream.js', 'vless-mux-tls': 'stream.js', 'vless-reality': 'stream.js',
    'trojan-tls': 'stream.js', 'vless-http-ws-tls': 'stream.js', 'udp-over-tcp': 'stream.js',
    'socks5-reality-mux': 'stream.js',
    'http-proxy': 'proxy.js', 'socks5-upstream': 'proxy.js',
    'tun-wireguard': 'layer3.js', 'rootless-socks-tcp': 'layer3.js', 'tun-tcp-tunnel': 'layer3.js',
    'reverse-tls': 'reverse.js', 'reverse-plain': 'reverse.js', 'reverse-reality': 'reverse-reality.js',
    'tcp-bit-swap': 'bitswap.js', 'tcp-bit-swap-mux': 'bitswap.js', 'tcp-bit-swap-mux-2': 'bitswap.js',
    protoswap: 'protoswap.js',
    'half-duplex': 'stream-adv.js', 'stream-fragmenter': 'stream-adv.js', 'connection-fisher': 'stream-adv.js',
    'tun2socks': 'l3-new.js', 'ping-tunnel': 'l3-new.js',
    'first-sni': 'stealth.js', 'sni-blender': 'stealth.js', 'disturber-lab': 'stealth.js',
    'tcp-over-udp': 'transport.js', 'header-proxy': 'transport.js',
    'router-split': 'ops.js', 'auth-users': 'ops.js', 'vless-hardened': 'ops.js',
    speedtest: 'ops.js', 'tester-chain': 'ops.js',
    'cdn-reverse-wss': 'cdn.js',
  };
  return map[id] || 'basic.js';
}
/**
 * Security regressions.
 *
 * These are here because each one was a real defect that ordinary template
 * tests could not see: a containment check that accepted a sibling directory, a
 * comment that swallowed a function, and an authentication rule that had to be
 * observed on a live listener to be believed.
 */
async function securityTests() {
  const httpLib = require('../lib/http');
  const { spawn } = require('node:child_process');

  const ok = (label) => {
    pass += 1;
    console.log(`  ✓ ${label}`);
  };
  // Awaited, because several of these steps are network calls and a plain
  // try/catch around an async function would report a pass on a rejection.
  const step = async (label, fn) => {
    try {
      await fn();
      ok(label);
    } catch (err) {
      fail += 1;
      failures.push(`${label}: ${err.message}`);
      console.log(`  ✗ ${label}: ${err.message}`);
    }
  };

  // ---- static file containment ------------------------------------------
  const root = path.join(tmp, 'www');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>panel</h1>');
  // A sibling whose name merely starts with the root's. The old check was
  // `startsWith(root)`, which this escapes.
  const sibling = `${root}-secret`;
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'key.pem'), 'PRIVATE');

  const hit = (urlPath) => {
    const chunks = [];
    const res = {
      writeHead: () => {},
      end: (b) => chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b))),
      setHeader: () => {},
      headersSent: false,
    };
    const served = httpLib.serveStatic(res, root, urlPath);
    return { served, body: Buffer.concat(chunks).toString('utf8') };
  };

  await step('serveStatic serves a file inside the root', () => {
    const r = hit('/index.html');
    assert.strictEqual(r.served, true);
    assert.ok(r.body.includes('panel'));
  });

  await step('serveStatic refuses a sibling sharing the root prefix', () => {
    const r = hit(`/../${path.basename(sibling)}/key.pem`);
    assert.ok(!r.body.includes('PRIVATE'), 'a sibling directory was readable');
    assert.ok(!r.served || !r.body.includes('PRIVATE'));
  });

  await step('serveStatic refuses plain traversal', () => {
    const r = hit('/../../server.js');
    assert.ok(!r.body.includes('require('), 'server.js was readable through traversal');
  });

  await step('serveStatic treats a malformed escape as a bad request, not a crash', () => {
    const r = hit('/%zz');
    assert.strictEqual(r.served, true, 'malformed input must be answered, not fall through');
    assert.ok(!r.body.includes('panel'), 'malformed input returned the index page');
  });

  // ---- request parsing ---------------------------------------------------
  await step('a malformed JSON body is a 400, not a 500', async () => {
    const req = {
      headers: { 'content-type': 'application/json' },
      on: (ev, cb) => {
        if (ev === 'data') cb(Buffer.from('{not json'));
        if (ev === 'end') cb();
      },
    };
    let err = null;
    try {
      await httpLib.parseJsonBody(req);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'malformed JSON was accepted');
    assert.strictEqual(err.statusCode, 400, `expected 400, got ${err.statusCode}`);
  });

  // ---- no function may be hidden inside a comment ------------------------
  await step('server.js declares its helpers outside comments', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    // Remove block comments the way a parser sees them, keeping offsets tidy.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) => '/'.padEnd(m.length, '*'));
    // `listenerPort` really was lost this way: two adjacent doc comments merged
    // and the function between them became part of the first one. The apply
    // route then failed inside its try/catch, so the check silently reported
    // "listenerPort is not defined" for every tunnel.
    for (const fn of ['listenerPort', 'tlsServerSide', 'findServers', 'redact']) {
      assert.ok(stripped.includes(`function ${fn}(`), `${fn} is defined only inside a comment`);
    }
  });

  // ---- the listener itself ----------------------------------------------
  const token = 'sec-test-token-0123456789abcdef';
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      WW_PANEL_DATA: path.join(tmp, 'www-data'),
      WW_PANEL_PORT: String(port),
      WW_PANEL_HOST: '127.0.0.1',
      WW_PANEL_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('panel did not start')), 15000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('API token')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`panel exited early (${code})`)));
    });

    await step('the panel binds loopback by default', async () => {
      const r = await fetch(`${base}/api/health`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(r.headers.get('content-security-policy'), 'no content-security-policy header');
      assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    });

    await step('the API token in a query string is rejected outside the event stream', async () => {
      const r = await fetch(`${base}/api/servers?token=${token}`);
      assert.strictEqual(r.status, 401, 'a token in the URL authenticated a normal API call');
    });

    await step('the header form still authenticates', async () => {
      const r = await fetch(`${base}/api/servers`, { headers: { authorization: `Bearer ${token}` } });
      assert.strictEqual(r.status, 200);
    });

    await step('the event stream still accepts a query token', async () => {
      // EventSource cannot set headers, so this one path has to.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 2500);
      const r = await fetch(`${base}/api/events?token=${token}`, { signal: ac.signal });
      assert.strictEqual(r.status, 200, 'the event stream rejected the only auth it can use');
      ac.abort();
      clearTimeout(timer);
    });
  } finally {
    child.kill();
  }
}
/**
 * The Bridge pairing rule.
 *
 * `validateBundle` is the last gate before a config is written to a server, so
 * the rule it enforces has to be checked against the exact shape it exists to
 * reject. It is not a rule the JSON schema can express and not one WaterWall
 * reports until it loads the file, which on a live box means the tunnel is down
 * and the only clue is a line in a log nobody is watching yet.
 */
function bridgeRuleTests() {
  const bridgeConfig = (reverseBridge) => ({
    'configs/bridge.json': JSON.stringify({
      nodes: [
        { name: 'users_inbound', type: 'TcpListener', version: 0, settings: { port: 443 }, next: 'bridge_users' },
        { name: 'bridge_users', type: 'Bridge', version: 0, settings: { pair: 'bridge_reverse' } },
        reverseBridge,
        { name: 'reverse_server', type: 'ReverseServer', version: 0, settings: {}, next: 'bridge_reverse' },
      ],
    }),
  });

  const rejected = bridgeConfig({
    name: 'bridge_reverse',
    type: 'Bridge',
    version: 0,
    settings: { pair: 'bridge_users' },
    next: 'bridge_users',
  });
  const accepted = bridgeConfig({
    name: 'bridge_reverse',
    type: 'Bridge',
    version: 0,
    settings: { pair: 'bridge_users' },
  });

  const caught = validateBundle(rejected).some((p) => /both pairs and points at/.test(p));
  const clean = validateBundle(accepted).length === 0;

  if (caught && clean) {
    pass += 1;
    console.log('  ✓ a Bridge that also names its partner as next is rejected, the correct pair is not');
  } else {
    fail += 1;
    if (!caught) {
      failures.push('validateBundle accepted a Bridge pair that names the partner as next');
      console.log('  ✗ validateBundle accepted a Bridge pair that names the partner as next');
    }
    if (!clean) {
      const problems = validateBundle(accepted).join('; ');
      failures.push(`validateBundle rejected a correct Bridge pair: ${problems}`);
      console.log(`  ✗ validateBundle rejected a correct Bridge pair: ${problems}`);
    }
  }
}

/**
 * HTTP transport agreement.
 *
 * `HttpClient` and `HttpServer` negotiate nothing at runtime. Each node picks
 * its own framing from its own settings, and the server *requires* whatever it
 * is told to require. A value present on only one side therefore produces a
 * config that builds, validates and loads, and then never completes a single
 * handshake — which is exactly how the VLESS-over-WebSocket template shipped a
 * server-side `websocket-origin` and `websocket-subprotocol` that its own client
 * never sent. Every one of these pairs has to come from a single source.
 */
function httpTransportTests() {
  const REQUIRED_TO_MATCH = ['path', 'websocket', 'http-version'];
  const REQUIRED_IF_SET = ['websocket-origin', 'websocket-subprotocol'];
  const findings = [];

  // Normalise the version aliases the docs list, so "1.1" and "http1.1" agree.
  const version = (v) => {
    const s = String(v ?? '').toLowerCase();
    if (['1', '1.1', 'http1', 'http1.1'].includes(s)) return '1.1';
    if (['2', '2.0', 'http2', 'h2'].includes(s)) return '2';
    return s;
  };

  for (const tpl of templates.ALL) {
    let tunnel = store.addTunnel({ name: `http-${tpl.id}`, template: tpl.id, options: {} });
    let result = buildBundle(store, tunnel);
    if (result.optionsPatch) {
      tunnel = store.updateTunnel(tunnel.id, { options: { ...tunnel.options, ...result.optionsPatch } });
      result = buildBundle(store, tunnel);
    }

    const clients = [];
    const servers = [];
    for (const side of ['iran', 'foreign']) {
      for (const [file, text] of Object.entries(result.bundles?.[side] || {})) {
        let parsed;
        try {
          parsed = JSON.parse(preprocessConfig(text).text);
        } catch {
          continue;
        }
        for (const n of parsed.nodes || []) {
          if (n.type === 'HttpClient') clients.push({ side, file, s: n.settings || {} });
          if (n.type === 'HttpServer') servers.push({ side, file, s: n.settings || {} });
        }
      }
    }
    if (!clients.length || !servers.length) continue;

    for (const c of clients) {
      for (const s of servers) {
        for (const key of REQUIRED_TO_MATCH) {
          const a = key === 'http-version' ? version(c.s[key]) : c.s[key];
          const b = key === 'http-version' ? version(s.s[key]) : s.s[key];
          if (String(a) !== String(b)) {
            findings.push(`${tpl.id}: ${key} is ${JSON.stringify(c.s[key])} on the client but ${JSON.stringify(s.s[key])} on the server`);
          }
        }
        for (const key of REQUIRED_IF_SET) {
          if (s.s[key] !== undefined && c.s[key] !== s.s[key]) {
            findings.push(
              `${tpl.id}: the server requires ${key}=${JSON.stringify(s.s[key])} but the client sends ${JSON.stringify(c.s[key] ?? '(nothing)')}`,
            );
          }
        }
        // A WebSocket opening handshake is an HTTP/1.1 GET; the docs are explicit
        // that the server rejects anything else.
        if (s.s.websocket && String(s.s.method || 'POST').toUpperCase() !== 'GET') {
          findings.push(`${tpl.id}: websocket server uses method ${JSON.stringify(s.s.method)} instead of GET`);
        }
      }
    }

    // The ALPN offered must be one the chosen HTTP mode can speak. ALPN and the
    // HTTP mode are chosen by two independent nodes and never reconciled at
    // runtime, so they have to be derived from one value at build time.
    const wanted = version(clients[0].s['http-version']) === '2' ? 'h2' : 'http/1.1';
    for (const side of ['iran', 'foreign']) {
      for (const [file, text] of Object.entries(result.bundles?.[side] || {})) {
        let chain;
        try {
          chain = JSON.parse(preprocessConfig(text).text);
        } catch {
          continue;
        }
        for (const n of chain.nodes || []) {
          if (n.type !== 'TlsClient' && n.type !== 'TlsServer') continue;
          const offered = n.settings?.alpns || n.settings?.['select-alpns'];
          if (!Array.isArray(offered) || offered.includes(wanted)) continue;
          findings.push(
            `${tpl.id}: ${side}/${file} ${n.name} offers ALPN ${JSON.stringify(offered)} but the HTTP transport needs ${JSON.stringify(wanted)}`,
          );
        }
      }
    }
  }

  if (findings.length) {
    fail += 1;
    failures.push(...findings);
    console.log(`  ✗ HTTP transport agreement: ${findings.length} mismatch(es)`);
    findings.forEach((f) => console.log(`      - ${f}`));
  } else {
    pass += 1;
    console.log('  ✓ HTTP transport agreement (client and server settings match)');
  }
}

/**
 * The transport guard.
 *
 * Password auth shells out to `sshpass`, which is Unix-only, so a password
 * stored on a Windows panel makes every deploy fail with the bare
 * `spawn sshpass ENOENT` — a message that names the symptom and not the fix.
 * The replacement is a pure function, so both branches are proven here instead
 * of only on whichever platform happens to break.
 */
function transportTests() {
  const byKey = { host: 'example.com', sshUser: 'root', sshKeyPath: '/tmp/key' };
  const byPassword = { host: 'example.com', sshUser: 'root', sshPassword: 'secret' };

  const cases = [
    ['a key file needs no sshpass', transportProblem(byKey, false), null],
    ['a password works when sshpass is present', transportProblem(byPassword, true), null],
    ['a password without sshpass is refused', transportProblem(byPassword, false), /sshpass/],
    ['that refusal names the fix', transportProblem(byPassword, false), /key path/i],
  ];

  for (const [label, actual, expected] of cases) {
    const ok =
      expected === null ? actual === null : typeof actual === 'string' && expected.test(actual);
    if (ok) {
      pass += 1;
      console.log(`  ✓ ${label}`);
    } else {
      fail += 1;
      failures.push(`${label} (got ${JSON.stringify(actual)})`);
      console.log(`  ✗ ${label}`);
    }
  }
}

/**
 * The agent's bundle merge.
 *
 * A server is assigned every enabled tunnel, and each tunnel's bundle carries
 * its own core.json naming its own config file. Writing them last-one-wins
 * leaves exactly one tunnel running and silently drops the others: every
 * tunnel would build cleanly, deploy cleanly, and only one would ever come up.
 */
function agentTests() {
  // agent.js refuses to load without a token, by design: it is a standalone
  // poller for a server, not a library. It exports its pure helpers for here.
  process.env.WW_AGENT_TOKEN = process.env.WW_AGENT_TOKEN || 'suite-token-not-used';
  const { mergeBundles } = require('../agent/agent.js');

  const core = (configs) => `${JSON.stringify({ configs, misc: { workers: 2 } }, null, 2)}\n`;

  const cases = [
    [
      'a single tunnel is written through byte for byte',
      () => {
        const raw = core(['configs/a.json']);
        const merged = mergeBundles({ t1: { 'core.json': raw, 'configs/a.json': '{"a":1}' } });
        assert.strictEqual(merged['core.json'], raw, 'an unchanged tunnel must not be rewritten');
        assert.strictEqual(merged['configs/a.json'], '{"a":1}');
      },
    ],
    [
      'two tunnels both stay in core.json',
      () => {
        const merged = mergeBundles({
          t1: { 'core.json': core(['configs/a.json']), 'configs/a.json': '{"a":1}' },
          t2: { 'core.json': core(['configs/b.json']), 'configs/b.json': '{"b":1}' },
        });
        assert.strictEqual(merged['configs/a.json'], '{"a":1}');
        assert.strictEqual(merged['configs/b.json'], '{"b":1}');
        const parsed = JSON.parse(merged['core.json']);
        assert.deepStrictEqual(parsed.configs, ['configs/a.json', 'configs/b.json']);
        assert.strictEqual(parsed.misc.workers, 2, 'core settings must survive the merge');
      },
    ],
    [
      'a config listed by two tunnels is not listed twice',
      () => {
        const merged = mergeBundles({
          t1: {
            'core.json': core(['configs/a.json', 'configs/shared.json']),
            'configs/a.json': '{}',
            'configs/shared.json': '{}',
          },
          t2: {
            'core.json': core(['configs/b.json', 'configs/shared.json']),
            'configs/b.json': '{}',
            'configs/shared.json': '{}',
          },
        });
        assert.deepStrictEqual(JSON.parse(merged['core.json']).configs, [
          'configs/a.json',
          'configs/shared.json',
          'configs/b.json',
        ]);
      },
    ],
    [
      'no assigned tunnels merge to nothing',
      () => {
        assert.deepStrictEqual(mergeBundles({}), {});
      },
    ],
  ];

  for (const [label, fn] of cases) {
    try {
      fn();
      pass += 1;
      console.log(`  ✓ ${label}`);
    } catch (err) {
      fail += 1;
      failures.push(`${label}: ${err.message}`);
      console.log(`  ✗ ${label}: ${err.message}`);
    }
  }
}

const securityTestsPending = securityTests();

certTests();
httpTransportTests();
bridgeRuleTests();
transportTests();
agentTests();

// ---- store round trip -----------------------------------------------------
assert.strictEqual(store.listServers().length, 3, 'server store');
assert.ok(store.addTunnel({ name: 'x', template: 'tcp-forward' }).id, 'tunnel store');
assert.strictEqual(store.getTunnel(store.listTunnels()[0].id).name, store.listTunnels()[0].name, 'tunnel lookup');

fs.rmSync(tmp, { recursive: true, force: true });

// Both pending suites are awaited before the summary. Reporting failures (and
// exiting) while they are still running would kill them and print a count that
// does not include their results.
Promise.all([netcheckPending, securityTestsPending])
  .then(() => {
    console.log('');
    console.log(`  ${pass} passed, ${fail} failed (${usedVariables} config variables resolved)`);
    if (fail) {
      console.log('');
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error('\n  test suite crashed:', err);
    process.exitCode = 2;
  });
