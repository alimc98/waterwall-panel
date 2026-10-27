'use strict';

/**
 * WaterWall core upgrades.
 *
 * The panel knows which release it is written against, but a box keeps
 * running whatever binary was installed on it. When upstream ships a new
 * release the operator has to walk every server by hand: download the right
 * archive, pick the right build for the CPU, stop the service, replace the
 * binary, start it again, and hope the two ends of a tunnel were upgraded
 * together — the 1.5.0 release notes are explicit that a mixed pair does not
 * connect.
 *
 * This module does that work over SSH, from the panel:
 *
 *  - it picks the build from the *host's* CPU flags (a host without avx2
 *    cannot run the plain x86-64 build and restart-loops with "built for a
 *    newer x86-64 CPU"),
 *  - it keeps the old binary next to the new one,
 *  - it restarts every WaterWall service that runs from that binary, so the
 *    whole box moves to the new release at once,
 *  - and it refuses to upgrade only one end of a tunnel unless the caller
 *    explicitly asks for it.
 */

const https = require('node:https');
const { cmp, gte, normalise, CURRENT } = require('./versions');
const { shellQuote } = require('./ssh');

const GITHUB_REPO = process.env.WW_GITHUB_REPO || 'radkesvat/WaterWall';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

/** Only these assets are usable on a Linux server. */
const LINUX_ASSET = /^Waterwall-linux-(gcc|clang)-(x64|arm64)(-old-cpu)?\.zip$/;

/** How long a GitHub API call may take. */
const API_TIMEOUT_MS = 30000;

// ------------------------------------------------------------------ releases

/**
 * Fetch the upstream releases, newest first.
 *
 * @param {object} opts
 * @param {number} [opts.limit]  how many releases to keep
 * @param {boolean} [opts.includePrerelease]
 */
function fetchReleases({ limit = 10, includePrerelease = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      RELEASES_API,
      {
        headers: {
          'User-Agent': 'waterwall-panel',
          Accept: 'application/vnd.github+json',
        },
        timeout: API_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchReleases({ limit, includePrerelease }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GitHub returned HTTP ${res.statusCode} for the release list`));
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let list;
          try {
            list = JSON.parse(raw);
          } catch {
            return reject(new Error('GitHub returned a release list that is not JSON'));
          }
          const out = [];
          for (const rel of Array.isArray(list) ? list : []) {
            if (!includePrerelease && rel?.prerelease) continue;
            const version = normalise(rel?.tag_name);
            if (!version) continue;
            const assets = (rel.assets || [])
              .filter((a) => LINUX_ASSET.test(a.name))
              .map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
            out.push({
              version,
              tag: rel.tag_name,
              publishedAt: rel.published_at,
              notes: (rel.body || '').slice(0, 4000),
              assets,
            });
          }
          resolve(out.slice(0, limit));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('the GitHub release list timed out')));
    req.on('error', reject);
  });
}

/**
 * Pick the asset for a host.
 *
 * `flags` is the CPU flag list reported by the host (`avx2`, `sse2`, …).
 * The plain x86-64 build needs avx2; without it the service dies at startup
 * with "This Waterwall binary was built for a newer x86-64 CPU than this
 * machine/OS exposes", so the old-cpu build has to be chosen instead.
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
  if (asset) return { asset, reason: hasAvx2 ? 'host supports avx2' : 'host has no avx2, using the old-cpu build' };
  // Fall back to whatever matches the architecture, so a release that drops
  // the old-cpu asset does not block the upgrade outright.
  const any = (assets || []).find((a) => a.name.includes(`-${arch}`));
  return any
    ? { asset: any, reason: `no ${wanted} in this release, falling back to ${any.name}` }
    : { asset: null, reason: `this release has no ${arch} build` };
}

// ------------------------------------------------------------------ planning

/**
 * What a host looks like right now, and what an upgrade would change.
 *
 * Read-only: it runs the same probes the install script uses, so the numbers
 * the panel shows are the numbers the server has.
 */
async function inspectHost(ssh, server) {
  const script = `
echo "ARCH=$(uname -m)"
echo "KERNEL=$(uname -r)"
if grep -qm1 avx2 /proc/cpuinfo; then echo "AVX2=yes"; else echo "AVX2=no"; fi
echo "UNITS=$(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -E '^waterwall' | tr '\\n' ' ')"
for d in /opt/waterwall /opt/waterwall-reality /opt/waterwall-london /opt/waterwall-cdn /opt/waterwall-cdn-cf /opt/waterwall-relay-entry; do
  if [ -d "$d" ]; then
    if [ -x "$d/Waterwall" ]; then echo "BIN=$d/Waterwall"; fi
    if [ -x "$d/WaterWall" ]; then echo "BIN=$d/WaterWall"; fi
  fi
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
  const units = field('UNITS').split(/\s+/).filter(Boolean);
  const binaries = [...out.matchAll(/^BIN=(.+)$/gm)].map((m) => m[1].trim());
  return {
    ok: true,
    arch,
    archRaw,
    kernel: field('KERNEL'),
    flags,
    units,
    binaries,
    hasAvx2: flags.includes('avx2'),
  };
}

/**
 * Compare the installed binary with the release the panel knows about.
 *
 * @param {object} host   the result of inspectHost
 * @param {string} version  the release the panel wants
 */
function planUpgrade(host, version, releases = []) {
  const target = normalise(version) || CURRENT;
  const release = releases.find((r) => r.version === target);
  const picked = pickAsset(release?.assets || [], host);
  const problems = [];
  if (!release) problems.push(`release ${target} was not found upstream`);
  if (!picked.asset) problems.push(picked.reason);
  return {
    version: target,
    newer: gte(target, CURRENT),
    asset: picked.asset,
    assetReason: picked.reason,
    problems,
    units: host.units || [],
    binaries: host.binaries || [],
  };
}

/**
 * Whether the release the panel knows about is newer than what a host runs.
 *
 * @param {string|null} installed  the version the agent reported
 * @param {string} target
 */
function isOutdated(installed, target = CURRENT) {
  const v = normalise(installed);
  if (!v) return true; // unknown: assume it needs the upgrade
  return cmp(v, normalise(target) || CURRENT) < 0;
}

// ------------------------------------------------------------------ applying

/**
 * Upgrade the WaterWall binary on one host.
 *
 * The work happens in two phases on purpose:
 *
 *  1. *install* — the new binary is downloaded, unpacked and put in place
 *     while the old one keeps running. A failed download leaves the box
 *     exactly as it was.
 *  2. *restart* — every service that runs from that binary is restarted
 *     together. Restarting them one at a time would break a tunnel whose two
 *     ends are upgraded in sequence.
 *
 * The old binary is kept as `<name>.bak-<version>` so the upgrade can be
 * undone by hand.
 *
 * @param {object} ssh
 * @param {object} server
 * @param {object} opts
 * @param {string} opts.assetUrl   the release asset to download
 * @param {string} opts.version    the version being installed
 * @param {string[]} opts.units    the services to restart
 * @param {boolean} opts.restart   run phase 2
 */
async function applyUpgrade(ssh, server, { assetUrl, version, units = [], restart = true, installOnly = false }) {
  if (!assetUrl) return { ok: false, error: 'no release asset to install' };
  const list = units
    .map((u) => String(u).replace(/[^A-Za-z0-9_.@-]/g, ''))
    .filter(Boolean)
    .map((u) => (u.endsWith('.service') ? u : `${u}.service`));
  const unitList = list.join(' ');

  // Phase 1 — download and install. The service keeps running the old binary.
  const installScript = `
set -u
URL=${shellQuote(assetUrl)}
VER=${shellQuote(String(version))}
TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT
echo "==> downloading $URL"
curl -fL --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 20 --max-time 600 \\
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
echo "NEW_BINARY=$NEW"
# Install into every directory that currently holds a WaterWall binary, so all
# the services on this box move to the same release together.
for d in $(ls -1d /opt/waterwall* 2>/dev/null); do
  [ -d "$d" ] || continue
  if [ -f "$d/Waterwall" ]; then OLD="$d/Waterwall"
  elif [ -f "$d/WaterWall" ]; then OLD="$d/WaterWall"
  else continue; fi
  cp -p "$OLD" "$OLD.bak-$VER" || { echo "BACKUP_FAILED:$d"; exit 8; }
  # The binary is usually running right now. Writing over it in place fails
  # with "Text file busy", so the new file is written next to it and then
  # renamed over the old one — the rename swaps the inode and the running
  # process keeps its own copy until it is restarted.
  cp -f "$NEW" "$OLD.new" || { echo "INSTALL_FAILED:$d"; exit 9; }
  chmod +x "$OLD.new"
  mv -f "$OLD.new" "$OLD" || { echo "INSTALL_FAILED:$d"; exit 9; }
  echo "INSTALLED=$OLD"
done
echo "INSTALL_OK"
`;
  const installRes = await ssh.sshExec(server, installScript, { timeout: 900000 });
  if (installRes.failed) {
    const out = `${installRes.stdout}${installRes.stderr}`;
    let error = 'the upgrade download or install failed';
    if (out.includes('DOWNLOAD_FAILED')) error = 'the release asset could not be downloaded';
    else if (out.includes('TOO_SMALL')) error = 'the downloaded asset is too small to be a WaterWall build';
    else if (out.includes('UNZIP_FAILED')) error = 'the release archive could not be unpacked';
    else if (out.includes('NO_UNZIP')) error = 'the host has neither unzip nor python3';
    else if (out.includes('NO_BINARY')) error = 'the release archive contains no WaterWall binary';
    else if (out.includes('BACKUP_FAILED')) error = 'the old binary could not be backed up';
    else if (out.includes('INSTALL_FAILED')) error = 'the new binary could not be installed';
    return { ok: false, error, detail: out.trim().slice(-2000) };
  }
  const installed = [...installRes.stdout.matchAll(/^INSTALLED=(.+)$/gm)].map((m) => m[1].trim());
  if (!installed.length) {
    return {
      ok: false,
      error: 'no WaterWall install directory was found on the host, so there was nothing to upgrade',
      detail: installRes.stdout.trim().slice(-2000),
    };
  }
  const result = { ok: true, installed, version, restarted: [] };

  if (!restart || installOnly) {
    result.note = 'the new binary is in place; the services still run the old one until they are restarted';
    return result;
  }

  // Phase 2 — restart every WaterWall service on the box, together.
  if (!unitList) {
    result.note = 'no WaterWall services were found to restart';
    return result;
  }
  const restartScript = `
set -u
FAILED=""
for u in ${unitList}; do
  systemctl restart "$u" >/dev/null 2>&1 || FAILED="$FAILED $u"
done
sleep 2
for u in ${unitList}; do
  echo "STATE:$u=$(systemctl is-active "$u" 2>/dev/null || true)"
done
[ -n "$FAILED" ] && echo "RESTART_FAILED:$FAILED"
exit 0
`;
  const restartRes = await ssh.sshExec(server, restartScript, { timeout: 300000 });
  const states = [...restartRes.stdout.matchAll(/^STATE:([^=]+)=(.*)$/gm)].map((m) => ({
    unit: m[1].trim(),
    state: m[2].trim(),
  }));
  result.services = states;
  result.restarted = states.filter((s) => s.state === 'active').map((s) => s.unit);
  const failedMatch = restartRes.stdout.match(/^RESTART_FAILED:(.*)$/m);
  if (failedMatch) {
    result.ok = false;
    result.error = `these services did not restart: ${failedMatch[1].trim()}`;
  }
  const notActive = states.filter((s) => s.state !== 'active');
  if (notActive.length && result.ok) {
    result.ok = false;
    result.error = `these services are not running after the upgrade: ${notActive
      .map((s) => `${s.unit} (${s.state})`)
      .join(', ')}`;
  }
  return result;
}

module.exports = {
  GITHUB_REPO,
  fetchReleases,
  pickAsset,
  inspectHost,
  planUpgrade,
  isOutdated,
  applyUpgrade,
};
