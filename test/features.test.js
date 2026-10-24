'use strict';

/**
 * Tests for the three features added on top of the upstream sync:
 *
 *  - service isolation: a second tunnel on one box gets its own unit,
 *  - port allocation: the second tunnel gets a port the first one is not
 *    holding, so both can run at the same time,
 *  - exit ordering: the order the user picked is the order the tunnel uses.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../lib/store');
const { buildBundle, versionMismatch } = require('../lib/build');
const templates = require('../lib/templates');
const isolate = require('../lib/isolate');
const portfix = require('../lib/portfix');
const versions = require('../lib/versions');
const { listenPorts, findFreePort, parseListeningPorts } = require('../lib/ports');
const { resolveTargets, targetsForSide, foreignIds } = require('../lib/targets');

/**
 * A stand-in for the ssh module.
 *
 * The real one opens a connection; these tests only care about the commands
 * the isolation and port code issue, so the stub records them and answers the
 * two shapes that matter: "is this path free?" and "which ports are open?".
 */
function fakeSsh({ openPorts = [], free = true, ownPorts = [], ownPid = 4242, otherPid = 9999 } = {}) {
  const calls = [];
  return {
    calls,
    shellQuote: (s) => `'${String(s).replace(/'/g, "'\\''")}'`,
    async sshExec(server, command) {
      calls.push({ server: server.id, command });
      // The probe runs several commands in one shell call, so the output can
      // contain both the socket list and the unit pids. Every part is
      // answered, and the parts are stitched together the way the shell
      // would.
      const parts = [];
      if (command.includes('systemctl show')) {
        const units = command.match(/'([A-Za-z0-9_.@-]+)'/g) || [];
        for (const raw of units) {
          const name = raw.slice(1, -1);
          parts.push(`Id=${name}.service`);
          parts.push(`MainPID=${ownPid}`);
        }
      }
      if (command.includes('ss -H -lntp')) {
        // The pid-aware pass: a port held by the tunnel's own process, and a
        // port held by somebody else.
        for (const p of openPorts) {
          const pid = ownPorts.includes(p) ? ownPid : otherPid;
          parts.push(`LISTEN 0 4096 0.0.0.0:${p} 0.0.0.0:* users:(("memfd:waterwall",pid=${pid},fd=10))`);
        }
      }
      if (command.includes('ss -H -lnt') && !command.includes('ss -H -lntp')) {
        for (const p of openPorts) {
          parts.push(`LISTEN 0 4096 0.0.0.0:${p} 0.0.0.0:*`);
        }
      }
      if (parts.length) return { ok: true, failed: false, stdout: parts.join('\n') };
      if (command.includes('FREE') || command.includes('TAKEN')) {
        return { ok: true, failed: false, stdout: free ? 'FREE' : 'TAKEN' };
      }
      return { ok: true, failed: false, stdout: '' };
    },
    async ensureWaterwallService(base, spec) {
      calls.push({ server: base.id, command: `ensure ${spec.serviceName} ${spec.waterwallPath}` });
      return { ok: true };
    },
  };
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwpanel-isolate-'));
  const s = new Store(dir);
  s.addServer({
    id: 'iran',
    name: 'Iran',
    role: 'iran',
    host: '10.0.0.1',
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
  });
  s.addServer({
    id: 'london',
    name: 'London',
    role: 'foreign',
    host: '203.0.113.10',
    waterwallPath: '/opt/waterwall-reality',
    serviceName: 'waterwall-reality',
  });
  s.addServer({
    id: 'romania',
    name: 'Romania',
    role: 'foreign',
    host: '203.0.113.20',
    waterwallPath: '/opt/waterwall-reality',
    serviceName: 'waterwall-reality',
  });
  return { store: s, dir };
}

function addReality(store, name, iranId, foreignIdsList) {
  return store.addTunnel({
    name,
    template: 'reverse-reality',
    targetServers: { iran: iranId, foreign: foreignIdsList },
    options: {},
  });
}

/** Fill in the provisioned options so the bundle has real ports. */
function provision(store, tunnel) {
  let built = buildBundle(store, tunnel);
  if (built.optionsPatch) {
    store.updateTunnel(tunnel.id, { options: { ...tunnel.options, ...built.optionsPatch } });
    built = buildBundle(store, tunnel);
  }
  return built;
}

async function tests(ok, fail, failures) {
  // `fail` is a counter, not a reference: incrementing a local copy would
  // leave the runner reporting a green suite with failures on screen. The
  // runner passes a callback so both sides see the same number.
  const recordFailure = typeof fail === 'function' ? fail : () => { fail += 1; };
  const check = (label, fn) => {
    try {
      fn();
      ok(label);
    } catch (err) {
      recordFailure(label, err);
      failures.push(`${label}: ${err.message}`);
      console.log(`  ✗ ${label}: ${err.message}`);
    }
  };

  const checkAsync = async (label, fn) => {
    try {
      await fn();
      ok(label);
    } catch (err) {
      recordFailure(label, err);
      failures.push(`${label}: ${err.message}`);
      console.log(`  ✗ ${label}: ${err.message}`);
    }
  };
  // ---- every template declares its listening ports ------------------------
  check('every template declares which options become listening ports', () => {
    const missing = templates.ALL.filter((t) => !t.listenPorts);
    assert.deepStrictEqual(
      missing.map((t) => t.id),
      [],
      `templates without listenPorts: ${missing.map((t) => t.id).join(', ')}`,
    );
  });

  check('the listenPorts map has the expected shape', () => {
    for (const t of templates.ALL) {
      const m = t.listenPorts;
      assert.ok(Array.isArray(m.iran), `${t.id}: iran is not an array`);
      assert.ok(Array.isArray(m.foreign), `${t.id}: foreign is not an array`);
      assert.ok(Array.isArray(m.relay), `${t.id}: relay is not an array`);
      assert.ok(Array.isArray(m.pairs), `${t.id}: pairs is not an array`);
    }
  });

  check('the declared ports are the ports the config really binds', () => {
    const { store, dir } = freshStore();
    try {
      store.addServer({ id: 'relay', name: 'Relay', role: 'relay', host: '10.0.0.2' });
      for (const tpl of templates.ALL) {
        if (!tpl.sides.includes('iran') && !tpl.sides.includes('foreign')) continue;
        const tunnel = store.addTunnel({
          name: `ports-${tpl.id}`,
          template: tpl.id,
          targetServers:
            tpl.id === 'relay-reality'
              ? { relay: 'relay' }
              : { iran: 'iran', foreign: ['london'] },
          options: {},
        });
        const built = provision(store, tunnel);
        for (const side of ['iran', 'foreign', 'relay']) {
          const files = built.bundles[side];
          if (!files) continue;
          const declared = portfix.portKeysFor(tpl, side);
          if (!declared.length) continue;
          const bound = listenPorts(files).ports;
          for (const key of declared) {
            const value = Number(built.options?.[key] ?? tunnel.options?.[key]);
            if (!Number.isInteger(value)) continue;
            assert.ok(
              bound.has(value),
              `${tpl.id}/${side}: option ${key}=${value} is not a bound port (bound: ${[...bound.keys()].join(',')})`,
            );
          }
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- exit ordering ------------------------------------------------------
  check('the stored exit order is the order the tunnel uses', () => {
    const { store, dir } = freshStore();
    try {
      const londonFirst = addReality(store, 'London first', 'iran', ['london', 'romania']);
      const romaniaFirst = addReality(store, 'Romania first', 'iran', ['romania', 'london']);
      const targetsA = resolveTargets(store.listServers(), store.getTunnel(londonFirst.id));
      const targetsB = resolveTargets(store.listServers(), store.getTunnel(romaniaFirst.id));
      assert.deepStrictEqual(
        targetsA.foreign.map((s) => s.id),
        ['london', 'romania'],
        'first tunnel kept its order',
      );
      assert.deepStrictEqual(
        targetsB.foreign.map((s) => s.id),
        ['romania', 'london'],
        'second tunnel kept its order',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  check('swapping the exit order does not rewrite the other tunnel', () => {
    const { store, dir } = freshStore();
    try {
      const a = addReality(store, 'A', 'iran', ['london', 'romania']);
      const b = addReality(store, 'B', 'iran', ['romania', 'london']);
      store.updateTunnel(a.id, { targetServers: { iran: 'iran', foreign: ['romania', 'london'] } });
      const after = resolveTargets(store.listServers(), store.getTunnel(b.id));
      assert.deepStrictEqual(
        after.foreign.map((s) => s.id),
        ['romania', 'london'],
        'the untouched tunnel kept its own order',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- service isolation --------------------------------------------------
  check('a second tunnel on the same server is planned for isolation', () => {
    const { store, dir } = freshStore();
    try {
      const first = addReality(store, 'first', 'iran', ['london']);
      const second = addReality(store, 'second', 'iran', ['london']);
      const plan = isolate.isolationPlan(store, store.getTunnel(second.id), ['iran', 'foreign']);
      const shared = plan.filter((row) => row.server.id === 'london');
      assert.strictEqual(shared.length, 1, 'the shared exit is in the plan');
      assert.strictEqual(shared[0].sharedWith[0].id, first.id, 'the plan names the tunnel it collides with');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  check('a tunnel that owns its server alone is not planned for isolation', () => {
    const { store, dir } = freshStore();
    try {
      const only = addReality(store, 'only', 'iran', ['london']);
      const plan = isolate.isolationPlan(store, store.getTunnel(only.id), ['iran', 'foreign']);
      assert.deepStrictEqual(plan, [], 'nothing to isolate');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync('isolation gives the newcomer its own unit and install path', async () => {
    const { store, dir } = freshStore();
    try {
      const first = addReality(store, 'first', 'iran', ['london']);
      const second = addReality(store, 'second', 'iran', ['london']);
      const ssh = fakeSsh();
      const result = await isolate.isolateTargets(store, store.getTunnel(second.id), ['iran', 'foreign'], ssh);
      assert.strictEqual(result.ok, true, `isolation failed: ${JSON.stringify(result.skipped)}`);
      // Both the Iran box and the shared exit are cloned: each needs its own
      // unit and its own core.json.
      assert.strictEqual(result.clones.length, 2, `expected two clones, got ${result.clones.length}`);
      const foreignClone = result.clones.find((c) => c.side === 'foreign');
      assert.ok(foreignClone, 'the shared exit was cloned');
      assert.notStrictEqual(
        foreignClone.server.serviceName,
        'waterwall-reality',
        'the clone has its own unit',
      );
      assert.match(foreignClone.server.serviceName, /^waterwall-reality-\d+$/, 'the unit name is numbered');
      assert.match(
        foreignClone.server.waterwallPath,
        /^\/opt\/waterwall-reality-\d+$/,
        'the path is numbered',
      );
      // The first tunnel keeps the original record.
      assert.deepStrictEqual(
        foreignIds(store.getTunnel(first.id)),
        ['london'],
        'the first tunnel still points at the original record',
      );
      // The newcomer now points at the clone.
      assert.deepStrictEqual(
        result.targets.foreign,
        [foreignClone.server.id],
        'the newcomer points at the clone',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync('the clone is skipped when the server has no SSH access', async () => {
    const { store, dir } = freshStore();
    try {
      addReality(store, 'first', 'iran', ['london']);
      const second = addReality(store, 'second', 'iran', ['london']);
      const london = store.getServer('london');
      store.updateServer(london.id, { agentEnabled: true, sshPassword: '', sshKeyPath: '' });
      const ssh = fakeSsh();
      const result = await isolate.isolateTargets(
        store,
        store.getTunnel(second.id),
        ['iran', 'foreign'],
        ssh,
      );
      assert.strictEqual(result.ok, false, 'the isolation reports failure');
      assert.strictEqual(result.skipped.length, 1, 'the collision is reported');
      assert.match(result.skipped[0].reason, /SSH|ایجنت/, 'the reason names the missing access');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- port allocation ----------------------------------------------------
  check('a port another tunnel holds is reported as taken', () => {
    const { store, dir } = freshStore();
    try {
      const first = addReality(store, 'first', 'iran', ['london']);
      provision(store, store.getTunnel(first.id));
      const second = addReality(store, 'second', 'iran', ['london']);
      const tunnel = store.getTunnel(second.id);
      const built = provision(store, tunnel);
      // Both tunnels share the Iran box, so that is where the collision is.
      const taken = portfix.portsUsedByPeers(store, tunnel, store.getServer('iran'));
      const bound = listenPorts(built.bundles.iran).ports;
      const iranKeys = portfix.portKeysFor(templates.get('reverse-reality'), 'iran');
      const userPort = Number(built.options?.userPort ?? 443);
      assert.ok(iranKeys.includes('userPort'), 'userPort is a declared listening port');
      assert.ok(bound.has(userPort), `the bundle binds ${userPort}`);
      assert.ok(taken.has(userPort), `port ${userPort} should be taken by the first tunnel`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync('the newcomer is moved to a port the first one is not holding', async () => {
    const { store, dir } = freshStore();
    try {
      const first = addReality(store, 'first', 'iran', ['london']);
      provision(store, store.getTunnel(first.id));
      const second = addReality(store, 'second', 'iran', ['london']);
      let tunnel = store.getTunnel(second.id);
      let built = provision(store, tunnel);

      // The panel isolates first, then rebuilds against the clone. The clone
      // lives on the same host, so the port collision is still there.
      const ssh = fakeSsh();
      const isolation = await isolate.isolateTargets(store, tunnel, ['iran', 'foreign'], ssh);
      assert.strictEqual(isolation.ok, true, 'the isolation succeeded');
      tunnel = store.updateTunnel(tunnel.id, { targetServers: isolation.targets });
      built = buildBundle(store, tunnel);

      const before = Number(built.options?.userPort ?? tunnel.options?.userPort ?? 443);
      const fix = await portfix.resolvePortConflicts(
        store,
        tunnel,
        store.getServer('iran'),
        'iran',
        built,
        ssh,
      );
      const moved = fix.moved.find((m) => m.key === 'userPort');
      assert.ok(moved, 'the colliding port was moved');
      assert.notStrictEqual(moved.to, moved.from, 'the port changed');
      assert.strictEqual(moved.from, before, 'the port that moved was the one in use');
      assert.ok(moved.to > 0 && moved.to <= 65535, 'the new port is valid');
      assert.notStrictEqual(moved.to, 443, 'the new port is not the default one');
      // The paired option follows, so both ends of the tunnel agree.
      assert.strictEqual(
        fix.options.reversePort,
        moved.to,
        'the paired port moved with it',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync('a port that is free is left alone', async () => {
    const { store, dir } = freshStore();
    try {
      const tunnel = addReality(store, 'alone', 'iran', ['london']);
      const built = provision(store, tunnel);
      const ssh = fakeSsh({ openPorts: [] });
      const fix = await portfix.resolvePortConflicts(
        store,
        store.getTunnel(tunnel.id),
        store.getServer('iran'),
        'iran',
        built,
        ssh,
      );
      assert.strictEqual(fix.moved.length, 0, 'nothing was moved');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync('a port the server already has open is respected', async () => {
    const { store, dir } = freshStore();
    try {
      const tunnel = addReality(store, 'alone', 'iran', ['london']);
      const built = provision(store, tunnel);
      const userPort = Number(built.options?.userPort ?? 443);
      const ssh = fakeSsh({ openPorts: [userPort] });
      const fix = await portfix.resolvePortConflicts(
        store,
        store.getTunnel(tunnel.id),
        store.getServer('iran'),
        'iran',
        built,
        ssh,
      );
      const moved = fix.moved.find((m) => m.key === 'userPort');
      assert.ok(moved, 'the open port was moved');
      assert.notStrictEqual(moved.to, userPort, 'the open port was not reused');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync('the tunnel keeps the port its own service already holds', async () => {
    // Re-applying a tunnel restarts its own service. The port that service
    // holds is not a collision — counting it would push the tunnel one port
    // further up on every apply and break the links its users already have.
    const { store, dir } = freshStore();
    try {
      const tunnel = addReality(store, 'again', 'iran', ['london']);
      const built = provision(store, tunnel);
      const userPort = Number(built.options?.userPort ?? 443);
      const ssh = fakeSsh({ openPorts: [userPort], ownPorts: [userPort] });
      const fix = await portfix.resolvePortConflicts(
        store,
        store.getTunnel(tunnel.id),
        store.getServer('iran'),
        'iran',
        built,
        ssh,
      );
      const moved = fix.moved.find((m) => m.key === 'userPort');
      assert.ok(!moved, 'the port was left alone');
      assert.strictEqual(fix.options.userPort, userPort, 'the stored port is unchanged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync('a port held by another process is still respected', async () => {
    // The own-service exemption must not cover sockets held by somebody else
    // on the same box.
    const { store, dir } = freshStore();
    try {
      const tunnel = addReality(store, 'other', 'iran', ['london']);
      const built = provision(store, tunnel);
      const userPort = Number(built.options?.userPort ?? 443);
      const ssh = fakeSsh({ openPorts: [userPort], ownPorts: [] });
      const fix = await portfix.resolvePortConflicts(
        store,
        store.getTunnel(tunnel.id),
        store.getServer('iran'),
        'iran',
        built,
        ssh,
      );
      const moved = fix.moved.find((m) => m.key === 'userPort');
      assert.ok(moved, 'the port was moved out of the way');
      assert.notStrictEqual(moved.to, userPort, 'the busy port was not reused');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- the small helpers --------------------------------------------------
  check('a free port is found next to the wanted one', () => {
    assert.strictEqual(findFreePort(443, new Set()), 443, 'a free port is kept');
    assert.strictEqual(findFreePort(443, new Set([443])), 444, 'the next port is taken');
    assert.strictEqual(findFreePort(443, new Set([443, 444, 445])), 446, 'the search walks up');
  });

  check('the wanted port is not given out when it is taken', () => {
    const taken = new Set([443, 444]);
    assert.ok(!taken.has(findFreePort(443, taken)), 'the found port is not in the taken set');
  });

  check('listening sockets are read out of ss output', () => {
    const out = [
      'LISTEN 0      4096         0.0.0.0:443              0.0.0.0:*',
      'LISTEN 0      4096       127.0.0.1:8443            0.0.0.0:*',
      'LISTEN 0      4096         [::]:22                   [::]:*',
    ].join('\n');
    const ports = parseListeningPorts(out);
    assert.ok(ports.has(443), 'port 443 was found');
    assert.ok(ports.has(8443), 'port 8443 was found');
    assert.ok(ports.has(22), 'port 22 was found');
  });

  check('a config with no listener binds nothing', () => {
    const ports = listenPorts({ 'configs/x.json': JSON.stringify({ nodes: [] }) }).ports;
    assert.strictEqual(ports.size, 0, 'no ports were found');
  });

  check('a connector is not mistaken for a listener', () => {
    const cfg = JSON.stringify({
      nodes: [{ name: 'out', type: 'TcpConnector', settings: { port: 443 } }],
    });
    assert.strictEqual(listenPorts({ 'configs/x.json': cfg }).ports.size, 0, 'no ports were found');
  });

  // ---- the 1.5.0 release --------------------------------------------------
  check('the panel targets the 1.5.0 release', () => {
    assert.strictEqual(versions.CURRENT, '1.5.0', 'CURRENT is 1.5.0');
    assert.ok(versions.RELEASE_NOTES['1.5.0'], 'the release notes are present');
  });

  check('1.5.0 ranks above the 1.46 series', () => {
    assert.ok(versions.cmp('1.5.0', '1.46.96') > 0, '1.5.0 is newer than 1.46.96');
    assert.ok(versions.cmp('1.46.96', '1.5.0') < 0, '1.46.96 is older than 1.5.0');
    assert.strictEqual(versions.cmp('1.50', '1.5.0'), 0, 'the 1.50 tag is the 1.5.0 binary');
    assert.ok(versions.cmp('1.46.8', '1.46.96') < 0, 'the patch level is compared within a minor');
  });

  check('two ends on different releases are reported', () => {
    const message = versionMismatch(
      {
        iran: { lastStatus: { waterwallVersion: '1.46.96' } },
        foreign: { lastStatus: { waterwallVersion: '1.5.0' } },
      },
      ['iran', 'foreign'],
    );
    assert.ok(message, 'the mismatch is reported');
    assert.match(message, /1\.46\.96/, 'the message names the versions');
    assert.match(message, /ReverseClient/, 'the message names the pair that breaks');
  });

  check('two ends on the same release are not reported', () => {
    const message = versionMismatch(
      {
        iran: { lastStatus: { waterwallVersion: '1.5.0' } },
        foreign: { lastStatus: { waterwallVersion: '1.5.0' } },
      },
      ['iran', 'foreign'],
    );
    assert.strictEqual(message, null, 'nothing is reported');
  });

  check('an unknown version is not treated as a mismatch', () => {
    const message = versionMismatch(
      { iran: { lastStatus: {} }, foreign: { lastStatus: { waterwallVersion: '1.5.0' } } },
      ['iran', 'foreign'],
    );
    assert.strictEqual(message, null, 'nothing is reported');
  });

  check('the mismatch reaches the bundle warnings', () => {
    const { store, dir } = freshStore();
    try {
      // `lastStatus` is written by the agent, not by the operator, so the test
      // reports it the same way the agent would.
      store.reportStatus('iran', { waterwallVersion: '1.46.96' });
      store.reportStatus('london', { waterwallVersion: '1.5.0' });
      const tunnel = addReality(store, 'mixed', 'iran', ['london']);
      const built = buildBundle(store, store.getTunnel(tunnel.id));
      assert.ok(
        built.warnings.some((w) => /یکسان نیست/.test(w)),
        `the warning is in the bundle: ${JSON.stringify(built.warnings)}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

module.exports = { tests };
