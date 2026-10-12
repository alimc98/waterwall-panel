'use strict';

const { spawn } = require('node:child_process');

/**
 * Remote operations through the system `ssh` / `scp` binaries.
 * No npm dependencies: the panel shells out to OpenSSH, which is present on
 * every Linux VPS. Password auth is handled with `sshpass` when available,
 * otherwise use a key file.
 */

function run(cmd, args, { input, timeout = 60000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeout)
      : null;

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, failed: true });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        failed: code !== 0 || timedOut,
        timedOut,
      });
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sshBaseArgs(server) {
  const args = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ConnectTimeout=10',
    '-p',
    String(server.sshPort || 22),
  ];
  if (server.sshKeyPath) args.push('-i', server.sshKeyPath);
  const binary = server.sshPassword ? 'sshpass' : 'ssh';
  if (server.sshPassword) {
    args.unshift('-p', server.sshPassword);
  }
  return { binary, args, target: `${server.sshUser}@${server.host}` };
}

async function sshExec(server, command, { timeout = 60000 } = {}) {
  const { binary, args, target } = sshBaseArgs(server);
  const full = [...args, target, command];
  return run(binary, full, { timeout });
}

async function sshScript(server, script, { timeout = 120000 } = {}) {
  return sshExec(server, script, { timeout });
}

/** Upload a set of in-memory files to `remoteBase` on the server. */
async function uploadFiles(server, files, remoteBase) {
  const { binary, args, target } = sshBaseArgs(server);
  const base = binary === 'sshpass' ? args.slice(1) : args;
  const scpArgs = [...base];

  // Stage the files in a remote temp dir, then move them into place.
  const tmp = `/tmp/wwpanel-${Date.now()}`;
  await sshExec(server, `mkdir -p ${shellQuote(tmp)}`);

  for (const [relPath, content] of Object.entries(files)) {
    if (relPath === 'core.json' || relPath.startsWith('configs/')) {
      // directories are created on the remote side
    }
    const remoteTmpFile = `${tmp}/${relPath.replace(/\//g, '__')}`;
    const scpCommand = server.sshPassword ? 'scppass' : 'scp';
    if (server.sshPassword && scpCommand === 'scppass') {
      // scppass reads the password from SSHPASS env
    }
    const proc = await new Promise((resolve) => {
      const child = spawn(
        scpCommand,
        [...scpArgs, '-', `${target}:${remoteTmpFile}`],
        { env: { ...process.env, SSHPASS: server.sshPassword || '' }, windowsHide: true },
      );
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => resolve({ code: -1, stderr: err.message, failed: true }));
      child.on('close', (code) => resolve({ code, stderr, failed: code !== 0 }));
      child.stdin.write(content);
      child.stdin.end();
    });
    if (proc.failed) {
      await sshExec(server, `rm -rf ${shellQuote(tmp)}`);
      return { ok: false, error: `scp failed for ${relPath}: ${proc.stderr}` };
    }
  }

  const script = `
set -e
BASE=${shellQuote(remoteBase)}
mkdir -p "$BASE/configs" "$BASE/log"
for f in ${Object.keys(files)
    .map((p) => shellQuote(p.replace(/\//g, '__')))
    .join(' ')}; do
  src=${shellQuote(tmp)}/$f
  dest="\$BASE/$f"
  # restore original relative path
  case "$f" in
    core.json) dest="\$BASE/core.json" ;;
    configs__*) rel="\${f#configs__}"; dest="\$BASE/configs/\${rel}" ;;
  esac
  if [ -f "$dest" ]; then cp "$dest" "\$dest.bak.\$(date +%s)"; fi
  mv "$src" "$dest"
done
rm -rf ${shellQuote(tmp)}
# The upstream release archive contains the binary as "Waterwall" (lowercase w),
# but plenty of guides and hand-made installs use "WaterWall". Linux paths are
# case sensitive, so match whichever actually exists.
if [ -f "$BASE/Waterwall" ]; then chmod +x "$BASE/Waterwall"; fi
if [ -f "$BASE/WaterWall" ]; then chmod +x "$BASE/WaterWall"; fi
echo OK
`;
  const res = await sshExec(server, script, { timeout: 120000 });
  if (res.failed) return { ok: false, error: res.stderr || 'remote write failed' };
  return { ok: true };
}

/** Download a remote file's contents over ssh. */
async function readRemoteFile(server, remotePath) {
  const res = await sshExec(server, `cat ${shellQuote(remotePath)} 2>/dev/null`);
  if (res.failed) return { ok: false, error: res.stderr };
  return { ok: true, content: res.stdout };
}

async function tailRemoteFile(server, remotePath, lines = 200) {
  const res = await sshExec(server, `tail -n ${Number(lines)} ${shellQuote(remotePath)} 2>/dev/null`);
  if (res.failed) return { ok: false, error: res.stderr };
  return { ok: true, content: res.stdout };
}

async function serviceAction(server, action) {
  const svc = shellQuote(server.serviceName || 'waterwall');
  const res = await sshExec(
    server,
    `systemctl ${action} ${svc} 2>&1; systemctl is-active ${svc} 2>&1`,
  );
  return { ok: !res.failed, output: `${res.stdout}${res.stderr}`.trim() };
}

async function serviceStatus(server) {
  const svc = shellQuote(server.serviceName || 'waterwall');
  const res = await sshExec(
    server,
    `systemctl is-active ${svc} 2>/dev/null; systemctl is-enabled ${svc} 2>/dev/null; systemctl show -p ActiveEnterTimestamp ${svc} 2>/dev/null`,
  );
  const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
  return {
    active: lines[0] || 'unknown',
    enabled: lines[1] || 'unknown',
    since: lines[2] ? lines[2].replace('ActiveEnterTimestamp=', '') : null,
  };
}

async function hostInfo(server) {
  const res = await sshExec(
    server,
    'uname -srm; nproc; (uptime -p 2>/dev/null || echo "-"); (curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || echo "-")',
  );
  if (res.failed) return { ok: false, error: res.stderr };
  const [kernel, cores, uptime, ip] = res.stdout.trim().split(/\r?\n/);
  return { ok: true, kernel, cores: Number(cores) || null, uptime, ip };
}

module.exports = {
  run,
  sshExec,
  sshScript,
  uploadFiles,
  readRemoteFile,
  tailRemoteFile,
  serviceAction,
  serviceStatus,
  hostInfo,
  shellQuote,
};
