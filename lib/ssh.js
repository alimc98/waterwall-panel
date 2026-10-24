'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

/**
 * Optional local SOCKS proxy (the panel's Xray outbound).
 *
 * The provider is a function rather than a value so that starting or stopping
 * the outbound takes effect on the next command without re-wiring anything.
 * `nc -X 5` is OpenBSD netcat's SOCKS5 mode, present on the Debian/Ubuntu
 * images these panels run on.
 */
let proxyPortProvider = null;

function setProxyPortProvider(fn) {
  proxyPortProvider = typeof fn === 'function' ? fn : null;
}

let proxyHelperResolved = null;

/**
 * Locate a netcat that understands `-X 5` (SOCKS5).
 *
 * OpenSSH has no SOCKS support of its own, so the ProxyCommand has to hand off
 * to netcat. `ncat` (nmap) and Debian's `netcat-openbsd` both accept `-X 5 -x`;
 * the traditional netcat (``netcat-traditional``) does not, so it is only used
 * if nothing better exists — a wrong binary fails with a clear ProxyCommand
 * error instead of silently connecting directly.
 */
function findProxyHelper() {
  if (proxyHelperResolved !== null) return proxyHelperResolved;
  const extensions = process.platform === 'win32' ? ['.exe', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of ['nc', 'ncat']) {
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = path.join(dir, name + ext);
        if (fs.existsSync(candidate)) {
          proxyHelperResolved = candidate;
          return candidate;
        }
      }
    }
  }
  proxyHelperResolved = '';
  return '';
}

function proxyArgs() {
  const port = proxyPortProvider && proxyPortProvider();
  if (!port) return [];
  const helper = findProxyHelper() || 'nc';
  return ['-o', `ProxyCommand=${helper} -X 5 -x 127.0.0.1:${Number(port)} %h %p`];
}

/**
 * Build the `ssh` (or `sshpass`) invocation for a server.
 *
 * Passwords go through the environment with `sshpass -e`, never `-p <password>`:
 * `-p` puts the secret in the process command line where any local user can
 * read it out of `ps` or the task manager. `sshpass` only exists on Linux, so on
 * Windows a key file is required rather than a password.
 */
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
    ...proxyArgs(),
  ];
  if (server.sshKeyPath) args.push('-i', server.sshKeyPath);
  const binary = server.sshPassword ? 'sshpass' : 'ssh';
  return { binary, args, target: `${server.sshUser}@${server.host}` };
}

/**
 * scp options, which are *not* interchangeable with ssh's.
 *
 * scp spells the port flag `-P`; lowercase `-p` means "preserve times" and takes
 * no argument. Reusing the ssh argument list verbatim makes scp read the port
 * number as a local filename ("stat local \"22\": No such file or directory").
 */
function scpBaseArgs(server) {
  const args = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    '-P',
    String(server.sshPort || 22),
    ...proxyArgs(),
  ];
  if (server.sshKeyPath) args.push('-i', server.sshKeyPath);
  return args;
}

/** Environment for the next spawn: SSHPASS carries the password out of argv. */
function sshEnv(server) {
  return server.sshPassword ? { SSHPASS: server.sshPassword } : {};
}

let sshpassOnPath = null;

/**
 * Whether `sshpass` can be spawned at all.
 *
 * Resolved by walking PATH rather than by running `which`: the answer cannot
 * change while the panel is up, and a spawn per call would be paid on every
 * command sent to every server.
 */
function hasSshpass() {
  if (sshpassOnPath !== null) return sshpassOnPath;
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  sshpassOnPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((ext) => fs.existsSync(path.join(dir, `sshpass${ext}`))));
  return sshpassOnPath;
}

/**
 * Why this server's transport cannot work, or null when it can.
 *
 * Password auth is built on `sshpass`, which is Unix-only. Without this check
 * the failure reaches the operator as the bare `spawn sshpass ENOENT`, which
 * names the symptom rather than the fix — and the fix is one line in the server
 * settings, not a debugging session.
 *
 * The presence of sshpass is a parameter on purpose, so both branches are
 * testable on any machine.
 */
function transportProblem(server, sshpassPresent = hasSshpass()) {
  if (!server.sshPassword || sshpassPresent) return null;
  return (
    'password authentication needs sshpass, which is not installed on the machine running the panel. ' +
    'Set an SSH key path on this server instead, or install sshpass.'
  );
}

async function sshExec(server, command, { timeout = 60000 } = {}) {
  const problem = transportProblem(server);
  if (problem) return { code: -1, stdout: '', stderr: problem, failed: true };
  const { binary, args, target } = sshBaseArgs(server);
  // sshpass -e reads SSHPASS from the environment, keeping the password out of
  // the command line.
  const full = binary === 'sshpass' ? ['-e', ...args, target, command] : [...args, target, command];
  return run(binary, full, { timeout, env: sshEnv(server) });
}

async function sshScript(server, script, { timeout = 120000 } = {}) {
  return sshExec(server, script, { timeout });
}

/** Upload a set of in-memory files to `remoteBase` on the server. */
async function uploadFiles(server, files, remoteBase) {
  const problem = transportProblem(server);
  if (problem) return { ok: false, error: problem };
  const { target } = sshBaseArgs(server);
  const scpOpts = scpBaseArgs(server);

  // Stage the files in a remote temp dir, then move them into place.
  const tmp = `/tmp/wwpanel-${Date.now()}`;
  await sshExec(server, `mkdir -p ${shellQuote(tmp)}`);

  // Modern OpenSSH (9.x) scp speaks SFTP and no longer accepts `-` to read from
  // stdin, so each file is written to a local temp file and copied from there.
  const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwpanel-'));

  try {
    for (const [relPath, content] of Object.entries(files)) {
      const remoteTmpFile = `${tmp}/${relPath.replace(/\//g, '__')}`;
      const localFile = path.join(localTmp, relPath.replace(/[/\\]/g, '_'));

      fs.writeFileSync(localFile, content, 'utf8');

      // scp is wrapped by sshpass exactly the way ssh is: `-e` plus SSHPASS in
      // the environment. There is no separate "scppass" tool to invoke.
      const scpBinary = server.sshPassword ? 'sshpass' : 'scp';
      const scpArgs = server.sshPassword ? ['-e', ...scpOpts] : [...scpOpts];

      const proc = await new Promise((resolve) => {
        const child = spawn(scpBinary, [...scpArgs, localFile, `${target}:${remoteTmpFile}`], {
          env: { ...process.env, ...sshEnv(server) },
          windowsHide: true,
        });
        let stderr = '';
        child.stderr.on('data', (d) => {
          stderr += d.toString();
        });
        child.on('error', (err) => resolve({ code: -1, stderr: err.message, failed: true }));
        child.on('close', (code) => resolve({ code, stderr, failed: code !== 0 }));
      });
      if (proc.failed) {
        await sshExec(server, `rm -rf ${shellQuote(tmp)}`);
        return { ok: false, error: `scp failed for ${relPath}: ${proc.stderr}` };
      }
    }
  } finally {
    fs.rmSync(localTmp, { recursive: true, force: true });
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

/**
 * Delete one tunnel's node config and the `.bak.*` copies next to it.
 *
 * Both writers keep a timestamped backup whenever they overwrite a file —
 * `uploadFiles` on a deploy, the agent on every config change — so a tunnel
 * that has been edited a few times leaves a pile behind. Removing the tunnel
 * has to take the whole set, not just the file `core.json` currently loads.
 *
 * `deleted` names the configs that were actually present, so the caller can
 * tell a tunnel that really ran here from one that was only *pointed* at this
 * server — and leave the latter's service alone instead of restarting a box
 * that is serving other tunnels.
 */
async function removeTunnelConfigs(server, remoteBase, relPaths) {
  const problem = transportProblem(server);
  if (problem) return { ok: false, error: problem };
  const configs = relPaths.filter((rel) => rel.startsWith('configs/'));
  if (!configs.length) {
    return { ok: false, error: 'this tunnel produced no config file on this server' };
  }
  const listConfigs = () =>
    `ls -1 ${shellQuote(`${remoteBase}/configs`)}/*.json 2>/dev/null | sed 's|.*/||' || true`;
  const script = [
    'set -u',
    "echo '=== before ==='",
    listConfigs(),
    ...configs.map(
      (rel) =>
        `if [ -f ${shellQuote(`${remoteBase}/${rel}`)} ]; then echo "had:${rel}"; fi`,
    ),
    ...configs.map(
      (rel) => `rm -f ${shellQuote(`${remoteBase}/${rel}`)} ${shellQuote(`${remoteBase}/${rel}`)}.bak.*`,
    ),
    "echo '=== after ==='",
    listConfigs(),
  ].join('\n');
  const res = await sshExec(server, script, { timeout: 60000 });
  if (res.failed) return { ok: false, error: res.stderr || 'remote delete failed' };
  const [before, after] = res.stdout.split('=== after ===');
  const parse = (text) =>
    text
      .replace('=== before ===', '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const lines = parse(before);
  return {
    ok: true,
    before: lines.filter((line) => !line.startsWith('had:')),
    deleted: lines.filter((line) => line.startsWith('had:')).map((line) => line.slice(4)),
    after: parse(after || ''),
  };
}

/**
 * Create a second WaterWall install on a server that already runs one.
 *
 * Used by the auto-isolation path when two tunnels would otherwise share the
 * same service name and directory. The binary is copied from an existing
 * install (no second download, so both services run exactly the same build),
 * a dedicated systemd unit is written, and the unit is enabled. The caller
 * deploys the tunnel afterwards and restarts it.
 *
 * Idempotent: an existing install with a binary and unit is accepted as-is.
 */
async function ensureWaterwallService(server, { sourcePath, waterwallPath, serviceName }) {
  const problem = transportProblem(server);
  if (problem) return { ok: false, error: problem };
  if (!/^[A-Za-z0-9_.@-]+$/.test(String(serviceName || ''))) {
    return { ok: false, error: `invalid service name "${serviceName}"` };
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(String(waterwallPath || ''))) {
    return { ok: false, error: `invalid install path "${waterwallPath}"` };
  }
  const source = String(sourcePath || '/opt/waterwall').replace(/\/+$/, '');
  const base = String(waterwallPath).replace(/\/+$/, '');
  const unitPath = `/etc/systemd/system/${serviceName}.service`;
  const script = `
set -e
SRC=${shellQuote(source)}
BASE=${shellQuote(base)}
SVC=${shellQuote(serviceName)}
mkdir -p "$BASE/configs" "$BASE/log"
if [ ! -x "$BASE/Waterwall" ] && [ ! -x "$BASE/WaterWall" ]; then
  if [ -x "$SRC/Waterwall" ]; then cp -p "$SRC/Waterwall" "$BASE/Waterwall"
  elif [ -x "$SRC/WaterWall" ]; then cp -p "$SRC/WaterWall" "$BASE/Waterwall"
  else echo "NO_BINARY:$SRC"; exit 3; fi
fi
chmod +x "$BASE/Waterwall" 2>/dev/null || true
cat > ${shellQuote(unitPath)} <<EOF
[Unit]
Description=WaterWall ${serviceName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$BASE
ExecStart=$BASE/Waterwall --config:$BASE/core.json
Restart=always
RestartSec=2
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${shellQuote(serviceName)} >/dev/null 2>&1 || true
echo "READY:${serviceName}:$BASE"
`;
  const res = await sshExec(server, script, { timeout: 120000 });
  if (res.failed) {
    const detail = `${res.stdout}${res.stderr}`.trim();
    return { ok: false, error: detail || `could not create ${serviceName} on ${base}` };
  }
  return { ok: true, serviceName, waterwallPath: base, output: res.stdout.trim() };
}

module.exports = {
  run,
  setProxyPortProvider,
  sshExec,
  sshScript,
  uploadFiles,
  readRemoteFile,
  tailRemoteFile,
  serviceAction,
  serviceStatus,
  hostInfo,
  ensureWaterwallService,
  removeTunnelConfigs,
  shellQuote,
  hasSshpass,
  transportProblem,
  findProxyHelper,
};
