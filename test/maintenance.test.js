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

check('the upgrade target is the release the panel knows about', () => {
  assert.strictEqual(versions.CURRENT, '1.5.0');
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

}

module.exports = { tests };
