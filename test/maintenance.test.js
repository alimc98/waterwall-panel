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

}

module.exports = { tests };
