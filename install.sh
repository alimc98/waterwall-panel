#!/usr/bin/env bash
#
# WaterWall Panel installer
# -------------------------
# Installs WaterWall itself, a systemd unit for it, and the panel agent on one
# server. Works fully offline: if GitHub is unreachable, point --waterwall-zip
# at a file you already have and the script will not touch the network at all.
#
#   # automatic: fetch everything from GitHub
#   curl -fsSL https://raw.githubusercontent.com/alimc98/waterwall-panel/main/install.sh \
#     | sudo bash -s -- --panel-url https://panel.example.com --agent-token TOKEN
#
#   # offline: nothing is downloaded
#   sudo ./install.sh --offline \
#     --waterwall-zip ./Waterwall-linux-gcc-x64-old-cpu.zip \
#     --agent-file ./agent.js \
#     --panel-url https://panel.example.com --agent-token TOKEN
#
# Run with --help for every option, or read docs/INSTALL-MANUAL.md for the
# step-by-step version with no script involved at all.
#
set -euo pipefail

WW_VERSION="${WW_VERSION:-1.5.2}"
WW_BASE="${WW_BASE:-/opt/waterwall}"
WW_SERVICE="${WW_SERVICE:-waterwall}"
WW_AGENT_DIR="${WW_AGENT_DIR:-/opt/ww-agent}"
WW_STATE_DIR="${WW_STATE_DIR:-/var/lib/ww-agent}"
WW_AGENT_SERVICE="${WW_AGENT_SERVICE:-ww-agent}"
WW_AGENT_INTERVAL="${WW_AGENT_INTERVAL:-15}"
WW_GITHUB_REPO="${WW_GITHUB_REPO:-radkesvat/WaterWall}"
# The panel's own repository, where the agent and the installer are
# published. A server outside the country fetches the agent from here
# rather than from the panel, because the path from the panel to a foreign
# box is the one that gets cut.
WW_PANEL_REPO="${WW_PANEL_REPO:-alimc98/waterwall-panel}"
# "auto" tries the sources in the order that fits where this server sits:
# a server in the same country as the panel takes the panel first, a server
# outside it takes GitHub first. "github" and "panel" force one of them.
WW_AGENT_SOURCE="${WW_AGENT_SOURCE:-auto}"
# Which country this server sits in. "foreign" is the safe default: a
# foreign box reaches GitHub without the interruption, and only falls back
# to the panel when it has to.
WW_ROLE="${WW_ROLE:-foreign}"

PANEL_URL="${WW_PANEL_URL:-}"
AGENT_TOKEN="${WW_AGENT_TOKEN:-}"
ARCH_OVERRIDE=""
WATERWALL_ZIP=""
AGENT_FILE=""
OFFLINE=0
SKIP_WATERWALL=0
SKIP_AGENT=0
SKIP_TUNING=0
FORCE=0

# ------------------------------------------------------------------ helpers

RED=''; GRN=''; YLW=''; DIM=''; RST=''
if [ -t 1 ]; then
  RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GRN" "$RST" "$GRN" "$*" "$RST"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    %s%s%s\n' "$YLW" "$*" "$RST"; }
die()  { printf '\n%sERROR:%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
WaterWall Panel installer

  --panel-url URL       Panel base URL the agent polls      (WW_PANEL_URL)
  --agent-token TOKEN   Per-server agent token              (WW_AGENT_TOKEN)
  --version VER         WaterWall release to install        (default 1.5.2)
  --base DIR            Install prefix                      (default /opt/waterwall)
  --arch ARCH           Force asset: x64 | x64-old | arm64 | arm64-old
  --waterwall-zip FILE  Install from this zip; implies --offline for the binary
  --agent-file FILE     Install the agent from this file instead of downloading
  --role ROLE           Where this server sits: iran | foreign    (WW_ROLE)
  --agent-source SRC    auto | github | panel                    (WW_AGENT_SOURCE)
  --offline             Never contact the network
  --skip-waterwall      Only install the agent
  --skip-agent          Only install WaterWall
  --skip-tuning         Do not touch sysctl / limits
  --force               Overwrite an existing install
  -h, --help            This text

Environment equivalents are shown above in parentheses.
USAGE
}

# ------------------------------------------------------------------ arguments

while [ $# -gt 0 ]; do
  case "$1" in
    --panel-url)       PANEL_URL="${2:-}"; shift 2 ;;
    --agent-token)     AGENT_TOKEN="${2:-}"; shift 2 ;;
    --version)         WW_VERSION="${2:-}"; shift 2 ;;
    --base)            WW_BASE="${2:-}"; shift 2 ;;
    --arch)            ARCH_OVERRIDE="${2:-}"; shift 2 ;;
    --waterwall-zip)   WATERWALL_ZIP="${2:-}"; shift 2 ;;
    --agent-file)      AGENT_FILE="${2:-}"; shift 2 ;;
    --role)            WW_ROLE="${2:-}"; shift 2 ;;
    --agent-source)    WW_AGENT_SOURCE="${2:-}"; shift 2 ;;
    --offline)         OFFLINE=1; shift ;;
    --skip-waterwall)  SKIP_WATERWALL=1; shift ;;
    --skip-agent)      SKIP_AGENT=1; shift ;;
    --skip-tuning)     SKIP_TUNING=1; shift ;;
    --force)           FORCE=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
done

# Report a bad combination of flags before asking for root: someone who typed
# --offine by mistake should hear about that, not about permissions.
if [ "$OFFLINE" -eq 1 ] && [ "$SKIP_WATERWALL" -eq 0 ] && [ "$SKIP_AGENT" -eq 0 ] \
   && [ -z "$WATERWALL_ZIP" ] && [ -z "$AGENT_FILE" ]; then
  die "--offline needs either --waterwall-zip or --agent-file, otherwise there is nothing to install from."
fi
if [ "$SKIP_AGENT" -eq 0 ]; then
  [ -n "$PANEL_URL" ] || die "--panel-url is required to install the agent (or pass --skip-agent)."
  [ -n "$AGENT_TOKEN" ] || die "--agent-token is required to install the agent (or pass --skip-agent)."
fi

if [ "$(id -u)" -ne 0 ]; then
  die "run as root:  sudo $0 ..."
fi

command -v systemctl >/dev/null 2>&1 || die "systemd is required; this installer targets Linux servers with systemd."

# ------------------------------------------------------------- architecture

# The release publishes separate builds per CPU feature set. "old-cpu" is the
# safe default: it runs everywhere x86-64 does. Picking the plain x64 build on a
# CPU without AVX gives an illegal-instruction crash at startup, which is a
# confusing failure to debug, so the conservative build wins unless told.
detect_arch() {
  if [ -n "$ARCH_OVERRIDE" ]; then
    case "$ARCH_OVERRIDE" in
      x64)       echo "linux-gcc-x64" ;;
      x64-old)   echo "linux-gcc-x64-old-cpu" ;;
      arm64)     echo "linux-gcc-arm64" ;;
      arm64-old) echo "linux-gcc-arm64-old-cpu" ;;
      clang)     echo "linux-clang-x64" ;;
      avx512)    echo "linux-clang-avx512f-x64" ;;
      *) die "unknown --arch '$ARCH_OVERRIDE' (see --help)" ;;
    esac
    return
  fi

  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64)
      if grep -qw avx /proc/cpuinfo 2>/dev/null; then
        echo "linux-gcc-x64"
      else
        echo "linux-gcc-x64-old-cpu"
      fi
      ;;
    aarch64|arm64)
      # The arm64 build targets a modern baseline already; there is no
      # "new-cpu" split to worry about.
      echo "linux-gcc-arm64"
      ;;
    *)
      die "unsupported CPU '$machine'. Build from source instead: see docs/INSTALL-MANUAL.md"
      ;;
  esac
}

# ------------------------------------------------------------------ download

# The asset name uses "Waterwall" while the repository is "WaterWall"; both
# spellings are correct and mismatching them is a 404.
asset_name() {
  echo "Waterwall-${1}.zip"
}

# Download a URL to a file, surviving the two ways a transfer to an Iranian
# or otherwise distant host usually breaks.
#
# 1. The connection can stall for minutes and then be reset by the path. A
#    stalled transfer is not a slow one: --speed-limit/--speed-time abort it
#    after 30 seconds below 1 KiB/s, so the retry starts a fresh connection
#    instead of waiting for a packet that will never arrive.
# 2. A reset mid-transfer leaves a *partial* file behind. curl exits non-zero
#    on the reset, but the bytes it did receive are already on disk, so the
#    caller must not trust the file it finds. The download therefore goes to a
#    temporary name and is only moved into place once it is complete.
#
# $1 url, $2 destination, $3 minimum size in bytes (0 = no minimum).
# Decode a base64 file. `base64 -d` is not on every minimal image, so
# openssl and python3 are tried as well.
decode_base64() {
  local file="$1"
  if command -v base64 >/dev/null 2>&1; then
    base64 -d "$file" && return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl base64 -d -in "$file" && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(open(sys.argv[1],"rb").read()))' "$file" && return 0
  fi
  if command -v busybox >/dev/null 2>&1; then
    busybox base64 -d "$file" && return 0
  fi
  return 1
}

fetch_file() {
  local url="$1" dest="$2" min="${3:-0}" tmp attempts=5
  tmp="${dest}.part.$$"

  if command -v curl >/dev/null 2>&1; then
    local attempt=1
    while [ "$attempt" -le "$attempts" ]; do
      rm -f "$tmp"
      info "downloading ${url} (attempt ${attempt}/${attempts})"
      if curl -fL --retry 2 --retry-delay 2 --retry-all-errors \
              --connect-timeout 20 --max-time 600 \
              --speed-limit 1024 --speed-time 30 \
              -o "$tmp" "$url"; then
        local size
        size="$(wc -c < "$tmp" 2>/dev/null || echo 0)"
        if [ "$size" -ge "$min" ] && [ "$size" -gt 0 ]; then
          mv -f "$tmp" "$dest"
          return 0
        fi
        warn "download finished but the file is only ${size} bytes; retrying."
      else
        warn "download failed or was interrupted; retrying."
      fi
      attempt=$((attempt + 1))
      [ "$attempt" -le "$attempts" ] && sleep $((attempt * 2))
    done
    rm -f "$tmp"
    return 1
  fi

  if command -v wget >/dev/null 2>&1; then
    local attempt=1
    while [ "$attempt" -le "$attempts" ]; do
      rm -f "$tmp"
      if wget -q --tries=3 --timeout=30 -O "$tmp" "$url"; then
        local size
        size="$(wc -c < "$tmp" 2>/dev/null || echo 0)"
        if [ "$size" -ge "$min" ] && [ "$size" -gt 0 ]; then
          mv -f "$tmp" "$dest"
          return 0
        fi
        warn "download finished but the file is only ${size} bytes; retrying."
      else
        warn "download failed or was interrupted; retrying."
      fi
      attempt=$((attempt + 1))
      [ "$attempt" -le "$attempts" ] && sleep $((attempt * 2))
    done
    rm -f "$tmp"
    return 1
  fi

  return 2
}

download_waterwall() {
  local arch asset url tmp
  arch="$(detect_arch)"
  asset="$(asset_name "$arch")"
  url="https://github.com/${WW_GITHUB_REPO}/releases/download/v${WW_VERSION}/${asset}"

  info "build       : ${arch}"
  info "asset       : ${asset}"
  info "url         : ${url}"

  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  if [ -n "$WATERWALL_ZIP" ]; then
    [ -f "$WATERWALL_ZIP" ] || die "--waterwall-zip: no such file: $WATERWALL_ZIP"
    info "source      : local file $WATERWALL_ZIP"
    cp "$WATERWALL_ZIP" "$tmp/$asset"
  else
    info "downloading …"
    fetch_file "$url" "$tmp/$asset" 1000000 \
      || die "download failed. If this server cannot reach GitHub, download the
zip elsewhere and re-run with:
  --waterwall-zip /path/to/$asset --offline"
  fi

  local size
  size="$(wc -c < "$tmp/$asset")"
  [ "$size" -gt 1000000 ] || die "downloaded file is only ${size} bytes; that is not a WaterWall build."
  info "size        : $((size / 1024)) KiB"

  # unzip may be absent on a minimal image; fall back to python3, then to busybox.
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$tmp/$asset" -d "$tmp/x"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$tmp/$asset" "$tmp/x" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    z.extractall(sys.argv[2])
PY
  elif command -v busybox >/dev/null 2>&1; then
    busybox unzip -q "$tmp/$asset" -d "$tmp/x"
  else
    die "need unzip, python3 or busybox to extract the archive."
  fi

  # The archive contains a single executable named "Waterwall".
  local bin
  bin="$(find "$tmp/x" -type f -name 'Waterwall' -o -type f -name 'WaterWall' | head -n1)"
  [ -n "$bin" ] || die "no Waterwall binary inside the archive."

  install -d -m 0755 "$WW_BASE" "$WW_BASE/configs" "$WW_BASE/log"
  install -m 0755 "$bin" "$WW_BASE/Waterwall"
  info "installed   : $WW_BASE/Waterwall"
}

# ------------------------------------------------------------------- service

write_unit() {
  cat > /etc/systemd/system/${WW_SERVICE}.service <<UNIT
[Unit]
Description=WaterWall
Documentation=https://github.com/${WW_GITHUB_REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${WW_BASE}
ExecStart=${WW_BASE}/Waterwall
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  info "unit        : /etc/systemd/system/${WW_SERVICE}.service"
}

# --------------------------------------------------------------------- agent

# The list of places the agent can be fetched from, in the order they are
# tried. The panel and GitHub each offer the raw file, a gzipped one and a
# base64-encoded one, because a path that refuses the raw bytes still
# carries the encoded ones.
agent_source_urls() {
  local base="${PANEL_URL%/}"
  local github="https://raw.githubusercontent.com/${WW_PANEL_REPO}/main"
  local panel_sources github_sources
  panel_sources="$base/agent.js $base/agent.js.gz $base/agent.js.b64"
  github_sources="$github/agent/agent.js $github/agent/agent.js.gz $github/agent/agent.js.b64"

  case "$WW_AGENT_SOURCE" in
    github) echo "$github_sources $panel_sources" ;;
    panel)  echo "$panel_sources $github_sources" ;;
    *)
      # auto: a server that shares the panel's country reaches the panel
      # instantly; a server outside it does not, and GitHub carries the
      # traffic without the interruption.
      if [ "$WW_ROLE" = "iran" ] || [ "$WW_ROLE" = "relay" ]; then
        echo "$panel_sources $github_sources"
      else
        echo "$github_sources $panel_sources"
      fi
      ;;
  esac
}

install_agent() {
  local target="${WW_AGENT_DIR}/agent.js"
  install -d -m 0755 "$WW_AGENT_DIR" "$WW_STATE_DIR"

  if [ -n "$AGENT_FILE" ]; then
    [ -f "$AGENT_FILE" ] || die "--agent-file: no such file: $AGENT_FILE"
    install -m 0755 "$AGENT_FILE" "$target"
    info "agent       : installed from $AGENT_FILE"
  else
    command -v node >/dev/null 2>&1 || die "Node.js 18+ is required to run the agent."
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$major" -ge 18 ] || die "Node.js 18+ required (found $(node -v))."

    # The agent is fetched from a list of sources rather than from one URL.
    #
    # The panel sits behind a long path to a foreign box, and the raw
    # agent.js does not always survive it: the transfer stops a few hundred
    # bytes in and is reset, which used to leave a truncated agent.js on
    # disk that then failed to parse. The same bytes gzip- or base64-encoded
    # come through whole, so each source offers all three forms.
    #
    # A server outside the country starts at GitHub, which carries the
    # traffic without the interruption, and falls back to the panel. A
    # server in the same country starts at the panel, which answers in
    # milliseconds.
    local tmp="${target}.download"
    local ok=0
    local src kind

    for src in $(agent_source_urls); do
      case "$src" in
        *.gz)  kind=gzip ;;
        *.b64) kind=base64 ;;
        *)     kind=raw ;;
      esac

      info "agent       : trying $src"
      rm -f "$tmp" "$tmp.gz" "$tmp.b64" "$tmp.out"

      if [ "$kind" = gzip ]; then
        if fetch_file "$src" "$tmp.gz" 500 \
           && gunzip -c "$tmp.gz" > "$tmp.out" 2>/dev/null \
           && [ "$(wc -c < "$tmp.out" 2>/dev/null || echo 0)" -ge 5000 ]; then
          mv -f "$tmp.out" "$tmp"
          ok=1
          break
        fi
      elif [ "$kind" = base64 ]; then
        if fetch_file "$src" "$tmp.b64" 500 \
           && decode_base64 "$tmp.b64" > "$tmp.out" 2>/dev/null \
           && [ "$(wc -c < "$tmp.out" 2>/dev/null || echo 0)" -ge 5000 ]; then
          mv -f "$tmp.out" "$tmp"
          ok=1
          break
        fi
      else
        if fetch_file "$src" "$tmp" 5000; then
          ok=1
          break
        fi
      fi
    done
    rm -f "$tmp.gz" "$tmp.b64" "$tmp.out"

    if [ "$ok" -eq 1 ]; then
      install -m 0755 "$tmp" "$target"
      rm -f "$tmp"
    else
      rm -f "$tmp"
      die "could not download the agent from any source.
The sources tried were: $(agent_source_urls)
If none of them is reachable, save agent.js on any machine that can reach
it and re-run with:  --agent-file /path/to/agent.js"
    fi
  fi
  chmod 0755 "$target"

  # Fall back to a system node when one is present, since the agent is started
  # by systemd without a login shell and would not find nvm/asdf shims.
  local nodebin=""
  for candidate in /usr/bin/node /usr/local/bin/node /opt/node/bin/node; do
    [ -x "$candidate" ] && { nodebin="$candidate"; break; }
  done
  [ -n "$nodebin" ] || nodebin="$(command -v node)"

  cat > /etc/systemd/system/${WW_AGENT_SERVICE}.service <<UNIT
[Unit]
Description=WaterWall Panel agent
After=network-online.target ${WW_SERVICE}.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${WW_AGENT_DIR}
ExecStart=${nodebin} ${target}
Restart=always
RestartSec=5
Environment=WW_PANEL_URL=${PANEL_URL}
Environment=WW_AGENT_TOKEN=${AGENT_TOKEN}
# The names have to be the ones agent.js reads: WW_AGENT_INTERVAL and
# WW_STATE. Exporting WW_INTERVAL/WW_STATE_DIR silently fell back to the
# defaults, so a custom interval or state path never took effect.
Environment=WW_AGENT_INTERVAL=${WW_AGENT_INTERVAL}
Environment=WW_WATERWALL_PATH=${WW_BASE}
Environment=WW_SERVICE=${WW_SERVICE}
Environment=WW_STATE=${WW_STATE_DIR}/state.json

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable "${WW_AGENT_SERVICE}.service"
  # `enable --now` starts a stopped unit but leaves a running one alone, so a
  # re-run with a new agent.js used to upgrade the file on disk and keep the old
  # code executing. The agent holds no state between polls, so restarting is
  # free.
  systemctl restart "${WW_AGENT_SERVICE}.service"
  info "agent unit  : ${WW_AGENT_SERVICE}.service (started)"
}

# -------------------------------------------------------------------- tuning

apply_tuning() {
  if [ "$SKIP_TUNING" -eq 1 ]; then
    info "tuning      : skipped"
    return
  fi
  # High connection counts are the norm for these tunnels; the defaults are too
  # low and surface as mysterious "too many open files" failures under load.
  cat > /etc/sysctl.d/99-waterwall.conf <<'SYSCTL'
# WaterWall tuning
net.core.somaxconn = 8192
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.ip_local_port_range = 10240 65000
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_congestion_control = bbr
fs.file-max = 1048576
SYSCTL
  if command -v sysctl >/dev/null 2>&1; then
    sysctl --system >/dev/null 2>&1 || warn "sysctl --system reported errors; check /etc/sysctl.d/99-waterwall.conf"
  fi

  cat > /etc/security/limits.d/99-waterwall.conf <<'LIMITS'
*  soft  nofile  1048576
*  hard  nofile  1048576
root soft  nofile  1048576
root hard  nofile  1048576
LIMITS
  info "tuning      : /etc/sysctl.d/99-waterwall.conf, /etc/security/limits.d/99-waterwall.conf"
}

# ---------------------------------------------------------------------- main

main() {
  cat <<BANNER
WaterWall Panel installer
  version   : ${WW_VERSION}
  base      : ${WW_BASE}
  panel     : ${PANEL_URL:-<not set>}
  mode      : $([ "$OFFLINE" -eq 1 ] && echo offline || echo online)
BANNER

  if [ "$SKIP_WATERWALL" -eq 0 ]; then
    step "Installing WaterWall ${WW_VERSION}"
    if [ -x "$WW_BASE/Waterwall" ] && [ "$FORCE" -eq 0 ]; then
      warn "$WW_BASE/Waterwall already exists; keeping it. Pass --force to replace."
    else
      download_waterwall
    fi
    write_unit
  else
    step "Skipping WaterWall (--skip-waterwall)"
  fi

  if [ "$SKIP_AGENT" -eq 0 ]; then
    step "Installing the panel agent"
    install_agent
  else
    step "Skipping the agent (--skip-agent)"
  fi

  apply_tuning

  step "Result"
  if [ "$SKIP_WATERWALL" -eq 0 ]; then
    # Start the core only when a config exists, otherwise it exits immediately
    # and the unit just flaps.
    if [ -f "$WW_BASE/core.json" ]; then
      if systemctl is-active --quiet "${WW_SERVICE}.service"; then
        # Already running: restarting here would drop every live connection to
        # reload code it is already running. A binary upgrade takes effect on
        # the next deliberate restart.
        info "waterwall   : already running (${WW_SERVICE}); not restarted"
      else
        systemctl enable --now "${WW_SERVICE}.service"
        info "waterwall   : started (${WW_SERVICE})"
      fi
    else
      systemctl enable "${WW_SERVICE}.service" 2>/dev/null || true
      warn "no ${WW_BASE}/core.json yet, so WaterWall was enabled but not started."
      warn "Create a tunnel in the panel and press Deploy; the agent writes core.json."
    fi
  fi

  cat <<DONE

  Panel        : ${PANEL_URL:-n/a}
  WaterWall    : ${WW_BASE}
  Core unit    : ${WW_SERVICE}.service
  Agent unit   : ${WW_AGENT_SERVICE}.service

  Next:
    1. In the panel, add this server and paste the Agent Token
       (Server settings -> Agent Token).
    2. Create a tunnel and press Deploy.
    3. Check it worked:  journalctl -u ${WW_SERVICE} -n 50 --no-pager

DONE
}

main