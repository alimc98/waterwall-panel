'use strict';

/**
 * Tests for the maintenance features:
 *
 *  - deleting a tunnel removes the service and the files it created,
 *  - upgrading the WaterWall core picks the build the host's CPU can run,
 *  - and the upgrade keeps the old binary and restarts every service.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const upgrade = require('../lib/upgrade');
const installer = require('../lib/install');
const sources = require('../lib/sources');
const ssh = require('../lib/ssh');
const versions = require('../lib/versions');

/**
 * A stand-in for the ssh module that answers the commands the upgrade and
 * the cleanup issue.
 *
 * `scripts` maps a fragment of a command to the output it produces; anything
 * unmatched succeeds with no output, so a test only has to describe the
 * parts it cares about.
 */
function fakeSsh({ scripts = [], stdout = '' } = {}) {
  const calls = [];
  return {
    calls,
    shellQuote: (s) => `'${String(s).replace(/'/g, "'\\''")}'`,
    async sshExec(server, command) {
      calls.push({ server: server.id, command });
      for (const [needle, reply] of scripts) {
        if (command.includes(needle)) {
          return {
            ok: !reply.failed,
            failed: Boolean(reply.failed),
            stdout: reply.stdout ?? '',
            stderr: reply.stderr ?? '',
          };
        }
      }
      return { ok: true, failed: false, stdout, stderr: '' };
    },
  };
}

/**
 * Run the checks.
 *
 * The runner owns the pass/fail counter, so the checks report through the
 * callbacks it hands in rather than keeping their own tally.
 */
async function tests(ok, fail, failures) {
  const recordFailure = (label, err) => {
    fail();
    failures.push(`${label}: ${err.message}`);
    console.log(`  \u2717 ${label}: ${err.message}`);
  };
  const check = (label, fn) => {
    try {
      fn();
      ok(label);
    } catch (err) {
      recordFailure(label, err);
    }
  };
  const checkAsync = async (label, fn) => {
    try {
      await fn();
      ok(label);
    } catch (err) {
      recordFailure(label, err);
    }
  };

// ------------------------------------------------------------------ upgrade

check('a host with avx2 gets the plain x64 build', () => {
  const assets = [
    { name: 'Waterwall-linux-gcc-x64.zip', url: 'u1' },
    { name: 'Waterwall-linux-gcc-x64-old-cpu.zip', url: 'u2' },
  ];
  const picked = upgrade.pickAsset(assets, { arch: 'x64', flags: ['avx2'] });
  assert.strictEqual(picked.asset.name, 'Waterwall-linux-gcc-x64.zip');
});

check('a host without avx2 gets the old-cpu build', () => {
  const assets = [
    { name: 'Waterwall-linux-gcc-x64.zip', url: 'u1' },
    { name: 'Waterwall-linux-gcc-x64-old-cpu.zip', url: 'u2' },
  ];
  // This is the host that restart-loops with "built for a newer x86-64 CPU"
  // when it is given the plain build.
  const picked = upgrade.pickAsset(assets, { arch: 'x64', flags: [] });
  assert.strictEqual(picked.asset.name, 'Waterwall-linux-gcc-x64-old-cpu.zip');
  assert.match(picked.reason, /old-cpu/);
});

check('an arm64 host gets the arm64 build', () => {
  const assets = [
    { name: 'Waterwall-linux-gcc-x64.zip', url: 'u1' },
    { name: 'Waterwall-linux-gcc-arm64.zip', url: 'u2' },
  ];
  const picked = upgrade.pickAsset(assets, { arch: 'arm64', flags: ['avx2'] });
  assert.strictEqual(picked.asset.name, 'Waterwall-linux-gcc-arm64.zip');
});

check('a release without the wanted build falls back to the same architecture', () => {
  // A release that only ships the plain x64 build, on a host that needs the
  // old-cpu one: the panel still has to install something.
  const assets = [{ name: 'Waterwall-linux-gcc-x64.zip', url: 'u1' }];
  const picked = upgrade.pickAsset(assets, { arch: 'x64', flags: [] });
  assert.ok(picked.asset, 'an asset was still chosen');
  assert.match(picked.reason, /falling back/);
});

check('a release with no build for the architecture is reported', () => {
  const picked = upgrade.pickAsset([], { arch: 'x64', flags: [] });
  assert.strictEqual(picked.asset, null);
  assert.match(picked.reason, /no x64 build/);
});

await checkAsync('the host inspection reads the architecture and the cpu flags', async () => {
  const ssh = fakeSsh({
    stdout: [
      'ARCH=x86_64',
      'KERNEL=5.15.0-91-generic',
      'AVX2=no',
      'UNITS=waterwall.service waterwall-reality.service',
      'BIN=/opt/waterwall/Waterwall',
      'BIN=/opt/waterwall-reality/Waterwall',
    ].join('\n'),
  });
  const host = await upgrade.inspectHost(ssh, { id: 's1' });
  assert.strictEqual(host.ok, true);
  assert.strictEqual(host.arch, 'x64');
  assert.strictEqual(host.hasAvx2, false);
  assert.deepStrictEqual(host.units, ['waterwall.service', 'waterwall-reality.service']);
  assert.deepStrictEqual(host.binaries, [
    '/opt/waterwall/Waterwall',
    '/opt/waterwall-reality/Waterwall',
  ]);
});

await checkAsync('a host that cannot be reached is reported, not thrown', async () => {
  const ssh = fakeSsh({ scripts: [['uname -m', { failed: true, stderr: 'connection refused' }]] });
  const host = await upgrade.inspectHost(ssh, { id: 's1' });
  assert.strictEqual(host.ok, false);
  assert.match(host.error, /connection refused/);
});

check('an unknown installed version counts as outdated', () => {
  assert.strictEqual(upgrade.isOutdated(null, '1.5.0'), true);
  assert.strictEqual(upgrade.isOutdated('', '1.5.0'), true);
});

check('a host on the target release is not outdated', () => {
  assert.strictEqual(upgrade.isOutdated('1.5.0', '1.5.0'), false);
  assert.strictEqual(upgrade.isOutdated('1.46.96', '1.5.0'), true);
});

check('the plan names the asset the host needs', () => {
  const releases = [
    {
      version: '1.5.0',
      assets: [
        { name: 'Waterwall-linux-gcc-x64.zip', url: 'u1' },
        { name: 'Waterwall-linux-gcc-x64-old-cpu.zip', url: 'u2' },
      ],
    },
  ];
  const plan = upgrade.planUpgrade(
    { arch: 'x64', flags: [], units: ['waterwall.service'], binaries: ['/opt/waterwall/Waterwall'] },
    '1.5.0',
    releases,
  );
  assert.strictEqual(plan.asset.name, 'Waterwall-linux-gcc-x64-old-cpu.zip');
  assert.deepStrictEqual(plan.problems, []);
});

check('the plan reports a release that does not exist', () => {
  const plan = upgrade.planUpgrade({ arch: 'x64', flags: ['avx2'], units: [], binaries: [] }, '9.9.9', []);
  assert.ok(plan.problems.length, 'the missing release is a problem');
});

await checkAsync('the upgrade keeps the old binary next to the new one', async () => {
  const ssh = fakeSsh({
    scripts: [['mktemp -d', { stdout: 'INSTALL_OK\nINSTALLED=/opt/waterwall/Waterwall\n' }]],
  });
  const res = await upgrade.applyUpgrade(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/build.zip',
    version: '1.5.0',
    units: [],
    restart: false,
  });
  assert.strictEqual(res.ok, true);
  const script = ssh.calls[0].command;
  assert.match(script, /cp -p "\$OLD" "\$OLD\.bak-\$VER"/, 'the old binary is backed up');
  assert.match(script, /INSTALLED=/, 'the install is reported');
});

await checkAsync('the upgrade restarts every waterwall service together', async () => {
  const ssh = fakeSsh({
    scripts: [
      ['mktemp -d', { stdout: 'INSTALL_OK\nINSTALLED=/opt/waterwall/Waterwall\n' }],
      [
        'systemctl restart',
        {
          stdout: [
            'STATE:waterwall.service=active',
            'STATE:waterwall-reality.service=active',
          ].join('\n'),
        },
      ],
    ],
  });
  const res = await upgrade.applyUpgrade(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/build.zip',
    version: '1.5.0',
    units: ['waterwall', 'waterwall-reality'],
    restart: true,
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.restarted, ['waterwall.service', 'waterwall-reality.service']);
  const restartScript = ssh.calls[1].command;
  assert.match(restartScript, /waterwall\.service waterwall-reality\.service/);
});

await checkAsync('a service that did not come back makes the upgrade a failure', async () => {
  const ssh = fakeSsh({
    scripts: [
      ['mktemp -d', { stdout: 'INSTALL_OK\nINSTALLED=/opt/waterwall/Waterwall\n' }],
      ['systemctl restart', { stdout: 'STATE:waterwall.service=activating\n' }],
    ],
  });
  const res = await upgrade.applyUpgrade(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/build.zip',
    version: '1.5.0',
    units: ['waterwall'],
    restart: true,
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /not running/);
});

await checkAsync('a failed download leaves the host alone and says so', async () => {
  const ssh = fakeSsh({
    scripts: [['mktemp -d', { failed: true, stdout: 'DOWNLOAD_FAILED\n' }]],
  });
  const res = await upgrade.applyUpgrade(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/build.zip',
    version: '1.5.0',
    units: ['waterwall'],
    restart: true,
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /could not be downloaded/);
  // The restart must not happen when the install failed.
  assert.strictEqual(ssh.calls.length, 1, 'no restart was attempted');
});

await checkAsync('a host with no waterwall install is reported as nothing to upgrade', async () => {
  const ssh = fakeSsh({ stdout: 'ARCH=x86_64\nKERNEL=5.15\nAVX2=yes\nUNITS=\n' });
  const host = await upgrade.inspectHost(ssh, { id: 's1' });
  assert.deepStrictEqual(host.binaries, []);
});

// ------------------------------------------------------------------ cleanup

await checkAsync('the cleanup stops the unit and deletes the unit file', async () => {
  const built = require('../lib/ssh').buildRemoveInstallScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: false,
  });
  assert.strictEqual(built.ok, true);
  assert.match(built.script, /systemctl stop "\$SVC"/);
  assert.match(built.script, /systemctl disable "\$SVC"/);
  assert.match(built.script, /rm -f "\$UNIT" "\$WANT"/, 'the unit file and the enable symlink go');
  assert.match(built.script, /daemon-reload/);
  assert.match(built.script, /reset-failed/);
});

await checkAsync('a clone install loses its directory too', async () => {
  const built = require('../lib/ssh').buildRemoveInstallScript({
    waterwallPath: '/opt/waterwall-reality-8',
    serviceName: 'waterwall-reality-8',
    removeDir: true,
  });
  assert.strictEqual(built.ok, true);
  assert.match(built.script, /rm -rf "\$BASE"/, 'the directory is removed');
  assert.match(built.script, /if \[ -d "\$BASE" \]; then/);
});

await checkAsync('a base install keeps its directory', async () => {
  const built = require('../lib/ssh').buildRemoveInstallScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: false,
  });
  assert.strictEqual(built.ok, true);
  assert.doesNotMatch(built.script, /rm -rf "\$BASE"/, 'the directory is kept');
});

await checkAsync('an install path that is not a real path is refused', async () => {
  const built = require('../lib/ssh').buildRemoveInstallScript({
    waterwallPath: '/; rm -rf /',
    serviceName: 'waterwall',
    removeDir: true,
  });
  assert.strictEqual(built.ok, false);
  assert.match(built.error, /invalid install path/);
});

await checkAsync('a service name that is not a systemd name is refused', async () => {
  const built = require('../lib/ssh').buildRemoveInstallScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall; rm -rf /',
    removeDir: true,
  });
  assert.strictEqual(built.ok, false);
  assert.match(built.error, /invalid service name/);
});

await checkAsync('an install path that walks out of its directory is refused', async () => {
  // The path becomes `rm -rf "$BASE"`. `/opt/waterwall/../..` is the root, so
  // a path that walks out has to be refused before the script is written.
  for (const bad of ['/opt/waterwall/../..', '/opt/../', '/../etc']) {
    const built = require('../lib/ssh').buildRemoveInstallScript({
      waterwallPath: bad,
      serviceName: 'waterwall',
      removeDir: true,
    });
    assert.strictEqual(built.ok, false, `${bad} was accepted`);
    assert.match(built.error, /invalid install path/);
  }
});

await checkAsync('the root is never removed as an install directory', async () => {
  for (const bad of ['/', '//']) {
    const built = require('../lib/ssh').buildRemoveInstallScript({
      waterwallPath: bad,
      serviceName: 'waterwall',
      removeDir: true,
    });
    assert.strictEqual(built.ok, false, `${bad} was accepted`);
  }
});

await checkAsync('the server cleanup refuses a path that walks out', async () => {
  const built = require('../lib/ssh').buildRemoveServerScript({
    waterwallPath: '/opt/waterwall/../..',
    serviceName: 'waterwall',
    removeDir: true,
    removeAgent: true,
    removeAllUnits: true,
  });
  assert.strictEqual(built.ok, false, 'the install path was accepted');
  assert.match(built.error, /invalid install path/);
});

await checkAsync('the server cleanup refuses an agent path that walks out', async () => {
  for (const agentDir of ['/opt/../../', '/', '/opt/ww-agent/../..']) {
    const built = require('../lib/ssh').buildRemoveServerScript({
      waterwallPath: '/opt/waterwall',
      serviceName: 'waterwall',
      removeDir: false,
      removeAgent: true,
      removeAllUnits: false,
      agentDir,
      agentStateDir: '/var/lib/ww-agent',
    });
    assert.strictEqual(built.ok, false, `agentDir ${agentDir} was accepted`);
    assert.match(built.error, /invalid agent path/);
  }
  for (const agentStateDir of ['/var/lib/../../', '/', '/var/lib/ww-agent/../..']) {
    const built = require('../lib/ssh').buildRemoveServerScript({
      waterwallPath: '/opt/waterwall',
      serviceName: 'waterwall',
      removeDir: false,
      removeAgent: true,
      removeAllUnits: false,
      agentDir: '/opt/ww-agent',
      agentStateDir,
    });
    assert.strictEqual(built.ok, false, `agentStateDir ${agentStateDir} was accepted`);
    assert.match(built.error, /invalid agent path/);
  }
});

await checkAsync('an oversized request body is answered as 413, not 500', async () => {
  // The size limit is the client's fault. A 500 blamed the panel and read as
  // a server fault, and on the routes that call readBody without a catch the
  // message went out as a plain internal error.
  const { readBody } = require('../lib/util');
  const { EventEmitter } = require('node:events');
  const req = new EventEmitter();
  req.destroy = () => { req.destroyed = true; };
  const promise = readBody(req, 10);
  req.emit('data', Buffer.alloc(6));
  req.emit('data', Buffer.alloc(6));
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the oversized body was accepted');
  assert.strictEqual(err.statusCode, 413, 'the failure was not marked as the client\'s fault');
  assert.strictEqual(req.destroyed, true, 'the stream was not stopped');
});

await checkAsync('a clone record can be repointed at a fresh install', async () => {
  // When a clone's unit vanishes from the box, the panel repoints the same
  // record at a new install instead of adding a second one. The record has
  // to name the tunnel that owns it *now* — otherwise the cleanup of that
  // tunnel does not recognise the record and it stays behind as an orphan.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { Store } = require('../lib/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwpanel-repoint-'));
  try {
    const store = new Store(dir);
    store.addServer({ id: 'base', name: 'Base', role: 'foreign', host: '1.2.3.4' });
    store.addServer({
      id: 'clone',
      name: 'Clone',
      role: 'foreign',
      host: '1.2.3.4',
      waterwallPath: '/opt/waterwall-2',
      serviceName: 'waterwall-2',
      clonedFrom: 'base',
      clonedFor: 'tunnel-1',
    });

    const updated = store.updateServer('clone', {
      waterwallPath: '/opt/waterwall-3',
      serviceName: 'waterwall-3',
      clonedFrom: 'base',
      clonedFor: 'tunnel-2',
    });
    assert.strictEqual(updated.clonedFor, 'tunnel-2', 'the new owner was not stored');
    assert.strictEqual(updated.clonedFrom, 'base', 'the base was not stored');

    // And it reached the disk, not just the in-memory copy.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'servers.json'), 'utf8'));
    const record = onDisk.find((s) => s.id === 'clone');
    assert.strictEqual(record.clonedFor, 'tunnel-2', 'the new owner did not reach the disk');
    assert.strictEqual(record.serviceName, 'waterwall-3', 'the new service name did not reach the disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await checkAsync('a clone that finds no binary leaves no directory behind', async () => {
  // The directory is created before the binary is copied, so a failure has to
  // take it away again. A half-made install with no binary in it makes the
  // next run give up: the path looks taken.
  const server = {
    host: '203.0.113.1',
    sshPort: 22,
    sshUser: 'root',
    sshKeyPath: '/opt/waterwall-panel/data/panel-ssh-key',
    transport: 'key',
  };
  const { EventEmitter } = require('node:events');
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  let script = '';
  childProcess.spawn = function patched(cmd, args) {
    script = (args || []).join(' ');
    const e = new EventEmitter();
    e.stdout = new EventEmitter();
    e.stderr = new EventEmitter();
    e.stdin = { write() {}, end() {} };
    process.nextTick(() => {
      e.stdout.emit('data', Buffer.from('NO_BINARY:/opt/waterwall\n'));
      e.emit('close', 3);
    });
    return e;
  };
  try {
    delete require.cache[require.resolve('../lib/ssh')];
    const stubbed = require('../lib/ssh');
    const res = await stubbed.ensureWaterwallService(server, {
      sourcePath: '/opt/waterwall',
      waterwallPath: '/opt/waterwall-9',
      serviceName: 'waterwall-9',
    });
    assert.strictEqual(res.ok, false, 'the clone was reported as ready');
    assert.match(res.error, /NO_BINARY/);
    assert.match(
      script,
      /CREATED=no/,
      'the script remembers whether it made the directory',
    );
    assert.match(
      script,
      /if \[ "\$CREATED" = yes \]; then rm -rf "\$BASE"; fi/,
      'the directory is taken away when the copy fails',
    );
    // The removal is guarded by the flag, so an existing install is never
    // removed by a failed copy.
    assert.match(
      script,
      /if \[ ! -d "\$BASE" \]; then CREATED=yes; fi/,
      'the flag is only set for a directory the script itself made',
    );
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[require.resolve('../lib/ssh')];
  }
});

await checkAsync('the clone source path is validated', async () => {
  // The source is where the binary is copied from. A relative path would
  // resolve against the SSH session's directory, and "/" would collapse to an
  // empty string and then to "/Waterwall" — outside any install the panel
  // knows about.
  //
  // The check runs before any SSH happens, so a bad path is refused without
  // touching a box. The good path does reach the SSH layer, so the module's
  // transport is stubbed for the duration of the test.
  const server = {
    host: '203.0.113.1',
    sshPort: 22,
    sshUser: 'root',
    sshKeyPath: '/opt/waterwall-panel/data/panel-ssh-key',
    transport: 'key',
  };
  const ssh = require('../lib/ssh');

  // A bad path never reaches the transport: the refusal comes first.
  for (const bad of ['/', 'relative/path', '/opt/waterwall/../../etc', '/opt/ww agent']) {
    const res = await ssh.ensureWaterwallService(server, {
      sourcePath: bad,
      waterwallPath: '/opt/waterwall-3',
      serviceName: 'waterwall-3',
    });
    assert.strictEqual(res.ok, false, `sourcePath ${bad} was accepted`);
    assert.match(res.error, /invalid source path/);
  }

  // An empty path falls back to the default install, and a normal path is
  // accepted. Both get as far as the transport, which is stubbed here.
  //
  // `ensureWaterwallService` reaches SSH through the module's own `run`,
  // which is a module-local call, so the stub has to be installed on the
  // child_process spawn BEFORE the ssh module is loaded.
  const { EventEmitter } = require('node:events');
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const seen = [];
  childProcess.spawn = function patched(cmd, args, opts) {
    seen.push((args || []).join(' '));
    const e = new EventEmitter();
    e.stdout = new EventEmitter();
    e.stderr = new EventEmitter();
    e.stdin = { write() {}, end() {} };
    process.nextTick(() => {
      e.stdout.emit('data', Buffer.from('READY:waterwall-3:/opt/waterwall-3\n'));
      e.emit('close', 0);
    });
    return e;
  };
  try {
    // A fresh copy of the module, loaded with the stub in place.
    delete require.cache[require.resolve('../lib/ssh')];
    const stubbed = require('../lib/ssh');
    const good = await stubbed.ensureWaterwallService(server, {
      sourcePath: '/opt/waterwall',
      waterwallPath: '/opt/waterwall-3',
      serviceName: 'waterwall-3',
    });
    assert.strictEqual(good.ok, true, `a normal source path was refused: ${good.error}`);
    const fallback = await stubbed.ensureWaterwallService(server, {
      sourcePath: '',
      waterwallPath: '/opt/waterwall-3',
      serviceName: 'waterwall-3',
    });
    assert.strictEqual(fallback.ok, true, `the fallback source was refused: ${fallback.error}`);
    assert.ok(
      seen.length >= 2 && seen.every((cmd) => cmd.includes("SRC='/opt/waterwall'")),
      'the source path in the script is the default install',
    );
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[require.resolve('../lib/ssh')];
  }
});

await checkAsync('the cleanup reports what it removed', async () => {
  const built = require('../lib/ssh').buildRemoveInstallScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: false,
  });
  // The script has to say what happened, because the panel reports it back
  // to the operator and a silent cleanup is a cleanup nobody trusts.
  assert.match(built.script, /UNIT_EXISTS=/);
  assert.match(built.script, /DIR_EXISTS=/);
  assert.match(built.script, /DIR_REMOVED=/);
  assert.match(built.script, /SVC_ACTIVE=/);
});

await checkAsync('deleting a server takes the unit, the symlink and the agent', async () => {
  const built = require('../lib/ssh').buildRemoveServerScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: true,
    removeAgent: true,
  });
  assert.strictEqual(built.ok, true);
  assert.match(built.script, /systemctl stop "\$SVC"/);
  assert.match(built.script, /systemctl disable "\$SVC"/);
  assert.match(built.script, /rm -f "\$UNIT" "\$WANT"/, 'the unit file and the enable symlink go');
  assert.match(built.script, /rm -rf "\$BASE"/, 'the install directory goes');
  assert.match(built.script, /rm -f \/etc\/systemd\/system\/ww-agent\.service/, 'the agent unit goes');
  assert.match(built.script, /rm -rf "\$AGENT_DIR"/, 'the agent directory goes');
  assert.match(built.script, /rm -rf "\$AGENT_STATE"/, 'the agent state goes');
  assert.match(built.script, /daemon-reload/);
});

await checkAsync('a server that shares its directory keeps it', async () => {
  const built = require('../lib/ssh').buildRemoveServerScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: false,
    removeAgent: true,
  });
  assert.strictEqual(built.ok, true);
  assert.doesNotMatch(built.script, /rm -rf "\$BASE"/, 'the shared directory is kept');
  assert.match(built.script, /rm -rf "\$AGENT_DIR"/, 'but the agent still goes');
});

await checkAsync('a server delete can leave the box alone', async () => {
  const built = require('../lib/ssh').buildRemoveServerScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: false,
    removeAgent: false,
  });
  assert.strictEqual(built.ok, true);
  assert.doesNotMatch(built.script, /rm -rf "\$BASE"/);
  assert.doesNotMatch(built.script, /rm -rf "\$AGENT_DIR"/);
  assert.doesNotMatch(built.script, /rm -f \/etc\/systemd\/system\/ww-agent\.service/);
});

await checkAsync('a server delete refuses a path that is not a real path', async () => {
  const built = require('../lib/ssh').buildRemoveServerScript({
    waterwallPath: '/; rm -rf /',
    serviceName: 'waterwall',
    removeDir: true,
    removeAgent: true,
  });
  assert.strictEqual(built.ok, false);
  assert.match(built.error, /invalid install path/);
});

await checkAsync('a server delete refuses a service name that is not a systemd name', async () => {
  const built = require('../lib/ssh').buildRemoveServerScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall; rm -rf /',
    removeDir: true,
    removeAgent: true,
  });
  assert.strictEqual(built.ok, false);
  assert.match(built.error, /invalid service name/);
});

await checkAsync('a server delete reports what it removed', async () => {
  const built = require('../lib/ssh').buildRemoveServerScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: true,
    removeAgent: true,
  });
  assert.match(built.script, /UNIT_EXISTS=/);
  assert.match(built.script, /DIR_REMOVED=/);
  assert.match(built.script, /AGENT_UNIT_EXISTS=/);
  assert.match(built.script, /AGENT_DIR_REMOVED=/);
  assert.match(built.script, /AGENT_STATE_REMOVED=/);
});

await checkAsync('a server delete can sweep every waterwall unit on the box', async () => {
  const built = require('../lib/ssh').buildRemoveServerScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: true,
    removeAgent: true,
    removeAllUnits: true,
  });
  assert.strictEqual(built.ok, true);
  // A unit left behind belongs to a tunnel the panel no longer knows, and the
  // operator has no way to reach it from the panel any more.
  assert.match(built.script, /list-unit-files/, 'the units are listed first');
  assert.ok(built.script.includes("grep -E '^(waterwall|ww-agent)'"),
    'only the panel\'s own units are swept');
  assert.match(built.script, /rm -f "\/etc\/systemd\/system\/\$u"/, 'the unit file goes');
  assert.match(built.script, /rm -f "\/etc\/systemd\/system\/multi-user\.target\.wants\/\$u"/,
    'the enable symlink goes too');
  assert.match(built.script, /SWEPT_UNITS=/, 'the script says what it swept');
});

await checkAsync('a server delete leaves the other units alone when told to', async () => {
  const built = require('../lib/ssh').buildRemoveServerScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: false,
    removeAgent: true,
    removeAllUnits: false,
  });
  assert.strictEqual(built.ok, true);
  assert.doesNotMatch(built.script, /list-unit-files/, 'no sweep happens');
  assert.match(built.script, /rm -f "\$UNIT" "\$WANT"/, 'but its own unit still goes');
});

check('the upgrade target is the release the panel knows about', () => {
  assert.strictEqual(versions.CURRENT, '1.5.2');
});

await checkAsync('the running binary is replaced by a rename, not a write', async () => {
  // Writing over a binary that is currently running fails with "Text file
  // busy". The new file is therefore written next to the old one and renamed
  // over it — the rename swaps the inode and the running process keeps its
  // own copy until it is restarted.
  const ssh = fakeSsh({
    stdout: 'INSTALLED=/opt/waterwall/Waterwall\n',
  });
  await upgrade.applyUpgrade(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/Waterwall-linux-gcc-x64.zip',
    version: '1.5.0',
    units: [],
    restart: false,
  });
  const script = ssh.calls[ssh.calls.length - 1].command;
  assert.match(script, /cp -f "\$NEW" "\$OLD\.new"/, 'the new binary is written next to the old one');
  assert.match(script, /mv -f "\$OLD\.new" "\$OLD"/, 'and then renamed over it');
  assert.doesNotMatch(script, /cp -f "\$NEW" "\$OLD"\s*\n/, 'no direct write over the running binary');
});

// ---------------------------------------------------------------- the install

await checkAsync('a host without avx2 gets the old-cpu build', async () => {
  // The plain x86-64 build is compiled for a newer CPU than some of the
  // servers have. It starts and then dies with "built for a newer x86-64
  // CPU", so the build has to follow the host's flags.
  const picked = installer.pickAsset(
    [
      { name: 'Waterwall-linux-gcc-x64.zip', url: 'https://example.test/x64.zip' },
      { name: 'Waterwall-linux-gcc-x64-old-cpu.zip', url: 'https://example.test/x64-old.zip' },
    ],
    { arch: 'x64', flags: [] },
  );
  assert.strictEqual(picked.asset.name, 'Waterwall-linux-gcc-x64-old-cpu.zip');
  assert.match(picked.reason, /no avx2/);
});

await checkAsync('a host with avx2 gets the plain build', async () => {
  const picked = installer.pickAsset(
    [
      { name: 'Waterwall-linux-gcc-x64.zip', url: 'https://example.test/x64.zip' },
      { name: 'Waterwall-linux-gcc-x64-old-cpu.zip', url: 'https://example.test/x64-old.zip' },
    ],
    { arch: 'x64', flags: ['avx2'] },
  );
  assert.strictEqual(picked.asset.name, 'Waterwall-linux-gcc-x64.zip');
});

await checkAsync('an arm host gets the arm build', async () => {
  const picked = installer.pickAsset(
    [
      { name: 'Waterwall-linux-gcc-x64.zip', url: 'https://example.test/x64.zip' },
      { name: 'Waterwall-linux-gcc-arm64.zip', url: 'https://example.test/arm.zip' },
    ],
    { arch: 'arm64', flags: ['avx2'] },
  );
  assert.strictEqual(picked.asset.name, 'Waterwall-linux-gcc-arm64.zip');
});

await checkAsync('the install writes the systemd unit the tunnel needs', async () => {
  // A tunnel applied to a box with no unit leaves "Unit waterwall.service
  // not found" behind, so the install has to create the unit as well as the
  // binary.
  const ssh = fakeSsh({ stdout: 'INSTALLED=/opt/waterwall/Waterwall\nUNIT=/etc/systemd/system/waterwall.service\nINSTALL_OK\n' });
  const res = await installer.installWaterwall(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/Waterwall-linux-gcc-x64.zip',
    version: '1.5.0',
    baseDir: '/opt/waterwall',
    serviceName: 'waterwall',
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.unit, '/etc/systemd/system/waterwall.service');
  const script = ssh.calls[ssh.calls.length - 1].command;
  assert.match(script, /cat > "\/etc\/systemd\/system\/\$SVC\.service"/, 'the unit is written');
  assert.match(script, /ExecStart=\$BASE\/Waterwall/, 'the unit runs the binary that was just installed');
  assert.match(script, /systemctl enable "\$SVC"/, 'and the unit is enabled so it survives a reboot');
  assert.match(script, /--speed-limit 1024/, 'the download fails instead of hanging when it stalls');
});

await checkAsync('the install refuses a path that could wipe the wrong directory', async () => {
  const ssh = fakeSsh({ stdout: '' });
  const res = await installer.installWaterwall(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/Waterwall-linux-gcc-x64.zip',
    baseDir: '/',
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /invalid install path/);
  assert.strictEqual(ssh.calls.length, 0, 'nothing is run on the server');
});

await checkAsync('a dry run changes nothing on the server', async () => {
  const ssh = fakeSsh({ stdout: '' });
  const res = await installer.installWaterwall(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/Waterwall-linux-gcc-x64.zip',
    dryRun: true,
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(ssh.calls.length, 0, 'the server is not touched');
});

await checkAsync('a failed download is reported, not swallowed', async () => {
  const ssh = fakeSsh({
    scripts: [['curl', { stdout: '', stderr: 'DOWNLOAD_FAILED', failed: true }]],
  });
  const res = await installer.installWaterwall(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/Waterwall-linux-gcc-x64.zip',
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /could not be downloaded/);
});

await checkAsync('the cleanup script runs to the end under set -u', async () => {
  // Every flag the script reads has to exist before the block that may set
  // it. The sweep only ran when there was something to sweep, so SWEPT was
  // undefined on a box with no leftover units - and under `set -u` the shell
  // stopped the script right there, leaving the enable symlinks behind.
  // The script is run with bash here so that regression cannot come back.
  const built = ssh.buildRemoveServerScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: true,
    removeAgent: true,
    removeAllUnits: true,
  });
  assert.strictEqual(built.ok, true);
  const { spawnSync } = require('node:child_process');
  const res = spawnSync('bash', ['-c', built.script], {
    encoding: 'utf-8',
    timeout: 60000,
  });
  // systemctl and rm may fail in a container, but the script must not die on
  // an undefined variable.
  assert.doesNotMatch(res.stderr || '', /unbound variable/, 'no flag is read before it is set');
  assert.match(res.stdout || '', /SWEPT_UNITS=/, 'the script reaches its last line');
  assert.match(res.stdout || '', /DIR_REMOVED=/, 'and reports what it removed');
});

await checkAsync('the sweep takes the dangling enable symlinks too', async () => {
  // An enable symlink whose unit file is already gone does not show up in
  // "systemctl list-unit-files", so a sweep that only walked that list left
  // the symlink behind in multi-user.target.wants.
  const built = ssh.buildRemoveServerScript({
    waterwallPath: '/opt/waterwall',
    serviceName: 'waterwall',
    removeDir: true,
    removeAgent: true,
    removeAllUnits: true,
  });
  const script = built.script;
  assert.match(
    script,
    /multi-user\.target\.wants\/waterwall\*\.service/,
    'the wants directory is swept for unit files that are already gone',
  );
  assert.match(script, /multi-user\.target\.wants\/ww-agent\*\.service/, 'and for the agent too');
});

await checkAsync('an existing install is left alone unless force is given', async () => {
  const ssh = fakeSsh({ stdout: 'ALREADY_INSTALLED:/opt/waterwall\n' });
  const res = await installer.installWaterwall(ssh, { id: 's1' }, {
    assetUrl: 'https://example.test/Waterwall-linux-gcc-x64.zip',
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.alreadyInstalled, true);
});


// ---------------------------------------------------------- where files come from

await check('a foreign server takes the agent from outside the country first', () => {
  // The panel is on an Iranian host. The path from there to a foreign box is
  // the one that gets cut: the raw agent.js stops a few hundred bytes in and
  // is reset. A foreign server therefore starts at GitHub and only falls
  // back to the panel.
  const list = sources.agentSources('http://panel.test:8787', { role: 'foreign' });
  assert.strictEqual(list[0].from, 'github');
  assert.strictEqual(list[0].url, 'https://raw.githubusercontent.com/alimc98/waterwall-panel/main/agent/agent.js');
  assert.strictEqual(list[list.length - 1].from, 'panel');
  assert.ok(list.some((s) => s.from === 'github' && s.kind === 'gzip'), 'the gzipped form is offered too');
  assert.ok(list.some((s) => s.from === 'github' && s.kind === 'base64'), 'and the base64 form');
  assert.ok(list.some((s) => s.from === 'panel' && s.kind === 'gzip'), 'the panel offers the same three forms');
});

await check('an Iranian server takes the agent from the panel first', () => {
  // The panel is right there and answers in milliseconds, so it is the first
  // choice; the foreign sources are the fallback.
  const list = sources.agentSources('http://panel.test:8787', { role: 'iran' });
  assert.strictEqual(list[0].from, 'panel');
  assert.strictEqual(list[0].url, 'http://panel.test:8787/agent.js');
  assert.strictEqual(list[list.length - 1].from, 'github');
});

await check('a relay server is treated as one inside the country', () => {
  const list = sources.agentSources('http://panel.test:8787', { role: 'relay' });
  assert.strictEqual(list[0].from, 'panel');
});

await check('the source order can be forced', () => {
  const forced = sources.agentSources('http://panel.test:8787', { role: 'iran', foreignFirst: true });
  assert.strictEqual(forced[0].from, 'github');
  const back = sources.agentSources('http://panel.test:8787', { role: 'foreign', foreignFirst: false });
  assert.strictEqual(back[0].from, 'panel');
});

await check('the installer itself is fetched from the source that fits', () => {
  const foreign = sources.installerSources('http://panel.test:8787', { role: 'foreign' });
  assert.strictEqual(foreign[0].from, 'github');
  assert.match(foreign[0].url, /public\/install-agent\.sh$/);
  const iran = sources.installerSources('http://panel.test:8787', { role: 'iran' });
  assert.strictEqual(iran[0].from, 'panel');
  assert.strictEqual(iran[0].url, 'http://panel.test:8787/install-agent.sh');
});

await check('the agent installers walk the source list', () => {
  // Both installers have to try the sources in turn, and each source has to
  // offer the encoded forms, because the path that refuses the raw bytes
  // still carries the encoded ones.
  for (const file of ['install.sh', 'public/install-agent.sh']) {
    const body = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(body, /agent_source_urls\(\)/, `${file} has a source list`);
    assert.match(body, /raw\.githubusercontent\.com/, `${file} knows about GitHub`);
    assert.match(body, /\*\.gz\)\s+kind=gzip/, `${file} handles the gzipped form`);
    assert.match(body, /\*\.b64\)\s+kind=base64/, `${file} handles the base64 form`);
    assert.match(body, /WW_ROLE/, `${file} takes the role into account`);
    assert.match(body, /WW_AGENT_SOURCE/, `${file} lets the source be forced`);
  }
});

await check('the agent installers take --role and --agent-source', () => {
  for (const file of ['install.sh', 'public/install-agent.sh']) {
    const body = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(body, /--role\)/, `${file} parses --role`);
    assert.match(body, /--agent-source\)/, `${file} parses --agent-source`);
  }
});

await check('the agent unit does not name a path that is not there', () => {
  // The unit's sandbox lists the WaterWall directory in ReadWritePaths. A
  // path that does not exist cannot be made writable, and systemd then
  // refuses to set the namespace up at all - the agent exits with
  // 226/NAMESPACE and restart-loops. The agent may well be installed before
  // WaterWall is, so the directory is only named when it is there.
  const body = fs.readFileSync(path.join(__dirname, '..', 'public', 'install-agent.sh'), 'utf8');
  assert.match(body, /SANDBOX_PATHS="\$WW_STATE_DIR"/, 'the sandbox starts from the state directory');
  assert.match(body, /if \[ -d "\$WW_WATERWALL_PATH" \]; then/, 'the WaterWall path is only named when it exists');
  assert.match(body, /ReadWritePaths=\$SANDBOX_PATHS/, 'and the unit uses the computed list');
  assert.match(body, /systemctl is-active --quiet "\$WW_SERVICE_NAME"/, 'a service that does not start is reported');
});

await check('the published forms of the agent can be rebuilt', () => {
  // The foreign server fetches the agent from GitHub, so the encoded forms
  // have to be in the repository. The build script is what puts them there.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'));
  const gz = require('node:zlib').gzipSync(raw, { level: 9 });
  const b64 = Buffer.from(raw).toString('base64');
  // the same bytes the script writes
  assert.strictEqual(require('node:zlib').gunzipSync(gz).length, raw.length);
  assert.strictEqual(Buffer.from(b64, 'base64').length, raw.length);
});

// ---------------------------------------------------------- scenario catalogue
//
// The catalogue is browser code, so the tests read `public/app.js` and run
// the filter functions in isolation. That way the test cannot drift away
// from what the browser actually executes.

/** Pull one top-level function out of the app source. */
function extractFunction(name) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is missing from app.js`);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} has no closing brace`);
}

/** The filter logic, rebuilt from the real source. */
function catalogueFilter() {
  const body = ['templateSearchText', 'templateMatches']
    .map(extractFunction)
    .join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return { templateSearchText, templateMatches };`)();
}

await check('the scenario search finds a scenario by its tag', () => {
  const { templateMatches } = catalogueFilter();
  const reality = {
    id: 'reverse-reality',
    title: 'Reverse Reality Tunnel',
    titleFa: 'تونل معکوس با Reality',
    summary: 'a reverse tunnel with reality',
    summaryFa: 'تونل معکوس با Reality',
    category: 'ops',
    categoryFa: 'عملیات',
    tags: ['reverse', 'reality', 'bridge', 'stealth', 'no-cert'],
  };
  assert.strictEqual(templateMatches(reality, ''), true, 'an empty search matches everything');
  assert.strictEqual(templateMatches(reality, 'reality'), true, 'the tag matches');
  assert.strictEqual(templateMatches(reality, 'REALITY'), true, 'the search ignores the case');
  assert.strictEqual(templateMatches(reality, 'معکوس'), true, 'the Persian title matches');
  assert.strictEqual(templateMatches(reality, 'reverse reality'), true, 'the English title matches');
  assert.strictEqual(templateMatches(reality, 'cdn'), false, 'an unrelated word does not match');
});

await check('every word of the search has to match', () => {
  // "cdn reverse" has to narrow the list down, not widen it: a search that
  // matched either word would show half the catalogue.
  const { templateMatches } = catalogueFilter();
  const cdn = {
    id: 'cdn-reverse-wss',
    title: 'Reverse WebSocket behind a CDN',
    titleFa: 'تونل معکوس WebSocket پشت CDN',
    summary: '',
    summaryFa: '',
    category: 'ops',
    categoryFa: 'عملیات',
    tags: ['cdn', 'websocket', 'wss', 'reverse', 'tls'],
  };
  assert.strictEqual(templateMatches(cdn, 'cdn'), true, 'one word matches');
  assert.strictEqual(templateMatches(cdn, 'cdn reverse'), true, 'both words match');
  assert.strictEqual(templateMatches(cdn, 'cdn trojan'), false, 'a word that is not there does not match');
});

await check('the scenario catalogue has a search box and a grouped list', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /id="tplSearch"/, 'the search box is rendered');
  assert.match(app, /tpl-picker-host/, 'the list can be swapped in place');
  assert.match(app, /tpl-group-head/, 'the categories have a header');
  assert.match(app, /CATEGORY_ORDER/, 'the categories are shown in a fixed order');
  assert.match(app, /function templateMatches/, 'the filter exists');
  assert.match(app, /function templatePickerHtml/, 'the picker groups the matches');
});

await check('the create form starts with no exit server selected', () => {
  // The picker used to pre-select the first foreign server in global order.
  // An operator who then added London followed by Romania got Romania first,
  // because the hidden pre-selection was already at the top of the list. The
  // create form must start empty so the stored array is exactly what the
  // operator adds.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /foreignPickerHtml\('nt', foreign, \[\]\)/, 'the create picker starts empty');
  assert.ok(
    !app.includes("foreignPickerHtml('nt', foreign, foreign.length ? [foreign[0].id] : [])"),
    'the first global exit is not pre-selected',
  );
  assert.match(app, /function exitOrderLabel/, 'the tunnel list shows the stored exit order');
});

await check('every scenario carries an icon', () => {
  const templates = require('../lib/templates');
  const catalog = templates.catalog();
  assert.ok(catalog.length > 30, 'the catalogue is not empty');
  for (const tpl of catalog) {
    assert.ok(tpl.icon, `${tpl.id} has no icon`);
    assert.strictEqual(typeof tpl.icon, 'string', `${tpl.id} has a text icon`);
  }
});

await check('the catalogue groups into named categories', () => {
  const templates = require('../lib/templates');
  const catalog = templates.catalog();
  const cats = [...new Set(catalog.map((t) => t.category))];
  assert.ok(cats.length >= 5, 'the catalogue is split into several categories');
  for (const tpl of catalog) {
    assert.ok(tpl.category, `${tpl.id} has no category`);
    assert.ok(tpl.categoryFa, `${tpl.id} has no Persian category name`);
  }
});

}

module.exports = { tests };
