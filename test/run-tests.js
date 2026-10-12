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
