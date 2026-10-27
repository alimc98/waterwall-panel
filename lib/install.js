'use strict';

/**
 * Install WaterWall on a server from the panel.
 *
 * The panel could already write a tunnel's config to a box and restart the
 * service, but it could not *install* WaterWall: the box needed a person to
 * run the install script by hand first. On a brand-new server that person
 * was the whole workflow — register the server, SSH in, paste a command,
 * wait for it to finish, and only then could a tunnel be applied.
 *
 * This module does that last part over SSH:
 *
 *  - it reads the host's CPU flags and picks the build that can run there
 *    (a host without avx2 cannot run the plain x86-64 build and restart-loops
 *    with "built for a newer x86-64 CPU"),
 *  - it downloads the release asset and unpacks it,
 *  - it writes the systemd unit, so `systemctl restart` afterwards finds a
 *    service to restart instead of "Unit waterwall.service not found",
 *  - and it enables the unit, so the tunnel survives a reboot.
 *
 * The unit is written but not started: the service needs a core.json, and
 * that file is the tunnel's business. The panel starts it when the tunnel is
 * applied.
 *
 * The download is the same one the upgrade path makes, so a box that cannot
 * reach GitHub gets the same clear failure rather than a hang.
 */

const { normalise, CURRENT } = require('./versions');
const { shellQuote } = require('./ssh');

/** The assets this module is willing to install. */
const LINUX_ASSET = /^Waterwall-linux-(gcc|clang)-(x64|arm64)(-old-cpu)?\.zip$/;

/**
 * Pick the asset for a host.
 *
 * @param {Array<{name: string, url: string, size: number}>} assets
 * @param {{arch: string, flags: string[]}} host
 */
function pickAsset(assets, host) {
  const arch = host?.arch === 'arm64' ? 'arm64' : 'x64';
  const hasAvx2 = (host?.flags || []).includes('avx2');
  const wanted = arch === 'arm64'
    ? (hasAvx2 ? 'Waterwall-linux-gcc-arm64.zip' : 'Waterwall-linux-gcc-arm64-old-cpu.zip')
    : (hasAvx2 ? 'Waterwall-linux-gcc-x64.zip' : 'Waterwall-linux-gcc-x64-old-cpu.zip');
  const asset = (assets || []).find((a) => a.name === wanted);
  if (asset) {
    return {
      asset,
      reason: hasAvx2 ? 'the host supports avx2' : 'the host has no avx2, so the old-cpu build is used',
    };
  }
  const any = (assets || []).find((a) => a.name.includes(`-${arch}`));
  return any
    ? { asset: any, reason: `the release has no ${wanted}, falling back to ${any.name}` }
    : { asset: null, reason: `the release has no ${arch} build` };
}

/**
 * Read what the host looks like: the architecture, the CPU flags, and
 * whether a WaterWall is already installed.
 *
 * @param {object} ssh
 * @param {object} server
 */
async function inspectHost(ssh, server) {
  const script = `
echo "ARCH=$(uname -m)"
if grep -qm1 avx2 /proc/cpuinfo; then echo "AVX2=yes"; else echo "AVX2=no"; fi
echo "UNITS=$(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -E '^waterwall' | tr '\\n' ' ')"
for d in $(ls -1d /opt/waterwall* 2>/dev/null); do
  if [ -x "$d/Waterwall" ]; then echo "BIN=$d/Waterwall"; fi
  if [ -x "$d/WaterWall" ]; then echo "BIN=$d/WaterWall"; fi
done
`;
  const res = await ssh.sshExec(server, script, { timeout: 60000 });
  if (res.failed) return { ok: false, error: res.stderr || 'could not inspect the host' };
  const out = res.stdout;
  const field = (name) => {
    const m = out.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const archRaw = field('ARCH');
  const arch = archRaw === 'aarch64' || archRaw === 'arm64' ? 'arm64' : 'x64';
  const flags = field('AVX2') === 'yes' ? ['avx2'] : [];
  return {
    ok: true,
    arch,
    archRaw,
    flags,
    hasAvx2: flags.includes('avx2'),
    units: field('UNITS').split(/\s+/).filter(Boolean),
    binaries: [...out.matchAll(/^BIN=(.+)$/gm)].map((m) => m[1].trim()),
  };
}

/**
 * Install WaterWall on a server: the binary, the systemd unit and the
 * enablement of that unit.
 *
 * @param {object} ssh
 * @param {object} server
 * @param {object} opts
 * @param {string} opts.assetUrl    the release asset to download
 * @param {string} opts.version     the version being installed
 * @param {string} opts.baseDir     the install directory
 * @param {string} opts.serviceName the systemd unit name
 * @param {boolean} opts.force      replace an existing install
 * @param {boolean} opts.dryRun     only say what would happen
 */
async function installWaterwall(ssh, server, {
  assetUrl,
  version = CURRENT,
  baseDir = '/opt/waterwall',
  serviceName = 'waterwall',
  force = false,
  dryRun = false,
}) {
  if (!assetUrl) return { ok: false, error: 'no release asset to install' };
  const base = String(baseDir || '').replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9._/-]+$/.test(base) || base === '/') {
    return { ok: false, error: `invalid install path "${baseDir}"` };
  }
  const svc = String(serviceName || '').replace(/\.service$/, '');
  if (!/^[A-Za-z0-9_.@-]+$/.test(svc)) {
    return { ok: false, error: `invalid service name "${serviceName}"` };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      baseDir: base,
      serviceName: svc,
      version: normalise(version) || CURRENT,
      note: 'nothing was changed on the server',
    };
  }

  const script = `
set -u
URL=${shellQuote(assetUrl)}
VER=${shellQuote(String(version))}
BASE=${shellQuote(base)}
SVC=${shellQuote(svc)}
FORCE=${shellQuote(force ? 'yes' : 'no')}
TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

mkdir -p "$BASE/configs" "$BASE/log"

if [ -x "$BASE/Waterwall" ] || [ -x "$BASE/WaterWall" ]; then
  if [ "$FORCE" != yes ]; then
    echo "ALREADY_INSTALLED:$BASE"
    exit 0
  fi
  if [ -x "$BASE/Waterwall" ]; then OLD="$BASE/Waterwall"; else OLD="$BASE/WaterWall"; fi
  cp -p "$OLD" "$OLD.bak-$VER" || { echo "BACKUP_FAILED"; exit 8; }
  rm -f "$BASE/Waterwall" "$BASE/WaterWall"
fi

echo "==> downloading $URL"
curl -fL --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 20 --max-time 900 \\
  --speed-limit 1024 --speed-time 30 -o "$TMP/build.zip" "$URL" || { echo "DOWNLOAD_FAILED"; exit 3; }
SIZE=$(wc -c < "$TMP/build.zip")
echo "SIZE=$SIZE"
[ "$SIZE" -gt 1000000 ] || { echo "TOO_SMALL:$SIZE"; exit 4; }

mkdir -p "$TMP/x"
if command -v unzip >/dev/null 2>&1; then
  unzip -oq "$TMP/build.zip" -d "$TMP/x" || { echo "UNZIP_FAILED"; exit 5; }
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/build.zip" "$TMP/x" || { echo "UNZIP_FAILED"; exit 5; }
else
  echo "NO_UNZIP"; exit 6
fi

NEW=""
for f in "$TMP/x/Waterwall" "$TMP/x/WaterWall" "$TMP/x/waterwall"; do
  [ -f "$f" ] && NEW="$f" && break
done
[ -n "$NEW" ] || { echo "NO_BINARY"; exit 7; }
chmod +x "$NEW"
cp -f "$NEW" "$BASE/Waterwall" || { echo "INSTALL_FAILED"; exit 9; }
chmod +x "$BASE/Waterwall"
echo "INSTALLED=$BASE/Waterwall"

cat > "/etc/systemd/system/$SVC.service" <<EOF
[Unit]
Description=WaterWall $SVC
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
systemctl enable "$SVC" >/dev/null 2>&1 || true
echo "UNIT=/etc/systemd/system/$SVC.service"
echo "INSTALL_OK"
`;

  const res = await ssh.sshExec(server, script, { timeout: 1200000 });
  const out = `${res.stdout}${res.stderr}`;
  if (res.failed || out.includes('INSTALL_FAILED')) {
    let error = 'the WaterWall install failed on the server';
    if (out.includes('DOWNLOAD_FAILED')) error = 'the release asset could not be downloaded';
    else if (out.includes('TOO_SMALL')) error = 'the downloaded asset is too small to be a WaterWall build';
    else if (out.includes('UNZIP_FAILED')) error = 'the release archive could not be unpacked';
    else if (out.includes('NO_UNZIP')) error = 'the host has neither unzip nor python3';
    else if (out.includes('NO_BINARY')) error = 'the release archive contains no WaterWall binary';
    else if (out.includes('BACKUP_FAILED')) error = 'the old binary could not be backed up';
    else if (out.includes('INSTALL_FAILED')) error = 'the binary could not be installed';
    return { ok: false, error, detail: out.trim().slice(-2000) };
  }
  const installed = [...out.matchAll(/^INSTALLED=(.+)$/gm)].map((m) => m[1].trim());
  const already = /ALREADY_INSTALLED:/.test(out);
  return {
    ok: true,
    alreadyInstalled: already,
    installed,
    unit: (out.match(/^UNIT=(.+)$/m) || [, null])[1],
    baseDir: base,
    serviceName: svc,
    version: normalise(version) || CURRENT,
    note: already
      ? 'WaterWall was already installed on this server; the unit was left as it was'
      : 'WaterWall is installed and the unit is enabled; it starts when a tunnel is applied',
  };
}

module.exports = {
  LINUX_ASSET,
  pickAsset,
  inspectHost,
  installWaterwall,
};
