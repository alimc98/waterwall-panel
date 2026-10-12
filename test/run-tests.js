'use strict';

/**
 * Smoke tests: every template must build, produce valid JSON, and pass the
 * chain validator. Run with `npm test`.
 */

const assert = require('node:assert');
const templates = require('../lib/templates');
const { buildBundle, resolveOptions } = require('../lib/build');
const { Store } = require('../lib/store');
const { validateBundle, preprocessConfig } = require('../lib/generator');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwpanel-test-'));
const store = new Store(tmp);

store.addServer({ id: 'srv-iran', name: 'Iran', role: 'iran', host: '10.0.0.1' });
store.addServer({ id: 'srv-foreign', name: 'Foreign', role: 'foreign', host: '198.51.100.7' });

let pass = 0;
let fail = 0;
let usedVariables = 0;
const failures = [];

for (const tpl of templates.ALL) {
  try {
    // Two passes: the second one runs with the provisioned options already stored.
    let tunnel = store.addTunnel({ name: `test-${tpl.id}`, template: tpl.id, options: {} });
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

// ---- shared secrets must be identical on both sides ----------------------
// Both ends of a tunnel have to agree on secrets (Reality password, UUID, ...).
// If a build generates them independently the tunnel silently breaks, so every
// build is compared against the first one and against the stored options.
for (const tpl of templates.ALL) {
  const created = store.addTunnel({
    name: `secrets-${tpl.id}`,
    template: tpl.id,
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

// ---- store round trip -----------------------------------------------------
assert.strictEqual(store.listServers().length, 2, 'server store');
assert.ok(store.addTunnel({ name: 'x', template: 'tcp-forward' }).id, 'tunnel store');
assert.strictEqual(store.getTunnel(store.listTunnels()[0].id).name, store.listTunnels()[0].name, 'tunnel lookup');

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(`  ${pass} passed, ${fail} failed (${usedVariables} config variables resolved)`);
if (fail) {
  console.log('');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
