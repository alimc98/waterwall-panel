#!/usr/bin/env bash
#
# WaterWall agent installer
# -------------------------
# Installs the panel agent on a WaterWall server so the panel can push
# configuration changes without an open SSH session.
#
#   curl -fsSL https://your-panel/install-agent.sh | sudo bash
#
# Or explicitly:
#   sudo WW_PANEL_URL=https://panel.example.com WW_AGENT_TOKEN=<token> bash install-agent.sh
#
set -euo pipefail

WW_AGENT_DIR="${WW_AGENT_DIR:-/opt/ww-agent}"
WW_STATE_DIR="${WW_STATE_DIR:-/var/lib/ww-agent}"
WW_SERVICE_NAME="${WW_SERVICE_NAME:-ww-agent}"
WW_WATERWALL_PATH="${WW_WATERWALL_PATH:-/opt/waterwall}"
WW_WATERWALL_SERVICE="${WW_WATERWALL_SERVICE:-waterwall}"
WW_AGENT_INTERVAL="${WW_AGENT_INTERVAL:-15}"

PANEL_URL="${WW_PANEL_URL:-}"
AGENT_TOKEN="${WW_AGENT_TOKEN:-}"
AGENT_FILE=""
# Which country this server sits in. "foreign" is the safe default: a
# foreign box reaches GitHub without the interruption, and only falls back
# to the panel when it has to.
WW_ROLE="${WW_ROLE:-foreign}"
WW_AGENT_SOURCE="${WW_AGENT_SOURCE:-auto}"

while [ $# -gt 0 ]; do
  case "$1" in
    --agent-file)   AGENT_FILE="${2:-}"; shift 2 ;;
    --role)         WW_ROLE="${2:-}"; shift 2 ;;
    --agent-source) WW_AGENT_SOURCE="${2:-}"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
WaterWall agent installer

 --agent-file FILE Install the agent from this file instead of downloading it
 --role ROLE       Where this server sits: iran | foreign (default foreign)
 --agent-source S  auto | github | panel (default auto)
 -h, --help         This text

Environment equivalents:
  WW_PANEL_URL     Panel base URL the agent polls
  WW_AGENT_TOKEN   Per-server agent token
  WW_AGENT_DIR     Install prefix (default /opt/ww-agent)
  WW_STATE_DIR     State directory (default /var/lib/ww-agent)
  WW_SERVICE_NAME  systemd unit name (default ww-agent)
  WW_ROLE          iran | foreign - decides which source is tried first
  WW_AGENT_SOURCE  auto | github | panel - forces one source
USAGE
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root (sudo)." >&2
  exit 1
fi

if [ -z "$PANEL_URL" ] || [ -z "$AGENT_TOKEN" ]; then
  echo "ERROR: WW_PANEL_URL and WW_AGENT_TOKEN are required." >&2
  echo "" >&2
  echo "  sudo WW_PANEL_URL=\"https://panel.example.com\" WW_AGENT_TOKEN=\"<token>\" bash install-agent.sh" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required (Node.js 18+)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ is required (found $(node -v))." >&2
  exit 1
fi

echo "==> Creating directories"
mkdir -p "$WW_AGENT_DIR" "$WW_STATE_DIR"

# ------------------------------------------------------------------ download
# The agent is fetched from a list of sources rather than from one URL.
#
# The panel sits behind a long path to a foreign box, and the raw agent.js
# does not always survive it: the transfer stops a few hundred bytes in and
# is reset, which used to leave a truncated agent.js on disk that then
# failed to parse. The same bytes gzip- or base64-encoded come through
# whole, so each source offers all three forms.
#
# A server outside the country starts at GitHub, which carries the traffic
# without the interruption, and falls back to the panel. A server in the
# same country starts at the panel, which answers in milliseconds.
WW_ROLE="${WW_ROLE:-foreign}"
WW_AGENT_SOURCE="${WW_AGENT_SOURCE:-auto}"
WW_PANEL_REPO="${WW_PANEL_REPO:-alimc98/waterwall-panel}"

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
      if [ "$WW_ROLE" = "iran" ] || [ "$WW_ROLE" = "relay" ]; then
        echo "$panel_sources $github_sources"
      else
        echo "$github_sources $panel_sources"
      fi
      ;;
  esac
}

echo "==> Downloading the agent"
AGENT_URL="$PANEL_URL/agent.js"
TMP_AGENT="$(mktemp)"

# The panel is reached over a long path, and a transfer that stalls is
# reset rather than completed. The download therefore retries, aborts a
# transfer that stops moving, and only accepts a file big enough to be the
# real agent — a truncated one would be installed and then fail to parse.
fetch_agent() {
  local url="${1:-$AGENT_URL}"
  local attempt=1 attempts=5 size
  while [ "$attempt" -le "$attempts" ]; do
    rm -f "$TMP_AGENT"
    if command -v curl >/dev/null 2>&1; then
      if curl -fsSL --retry 2 --retry-delay 2 --retry-all-errors \
              --connect-timeout 20 --max-time 600 \
              --speed-limit 1024 --speed-time 30 \
              -o "$TMP_AGENT" "$url"; then
        size="$(wc -c < "$TMP_AGENT" 2>/dev/null || echo 0)"
        if [ "$size" -ge 5000 ]; then
          return 0
        fi
        echo "    download finished but the file is only $size bytes; retrying" >&2
      else
        echo "    download failed or was interrupted; retrying" >&2
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q --tries=3 --timeout=30 -O "$TMP_AGENT" "$url"; then
        size="$(wc -c < "$TMP_AGENT" 2>/dev/null || echo 0)"
        if [ "$size" -ge 5000 ]; then
          return 0
        fi
        echo "    download finished but the file is only $size bytes; retrying" >&2
      else
        echo "    download failed or was interrupted; retrying" >&2
      fi
    else
      echo "ERROR: neither curl nor wget is available." >&2
      return 2
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le "$attempts" ] && sleep $((attempt * 2))
  done
  return 1
}

# The panel sits behind the same long-haul path as the server, and the raw
# agent.js does not always survive it: the transfer stops a few hundred bytes
# in and is reset. The same bytes gzip- or base64-encoded come through
# whole, so all three forms are tried in turn.
#
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

if [ -n "$AGENT_FILE" ]; then
  [ -f "$AGENT_FILE" ] || { echo "ERROR: --agent-file: no such file: $AGENT_FILE" >&2; exit 1; }
  cp -f "$AGENT_FILE" "$TMP_AGENT"
  echo "    using the local file $AGENT_FILE"
else
  BASE="${PANEL_URL%/}"
  ok=0
  src=""
  kind=""
  for src in $(agent_source_urls); do
    case "$src" in
      *.gz)  kind=gzip ;;
      *.b64) kind=base64 ;;
      *)     kind=raw ;;
    esac

    echo "    trying $src" >&2
    rm -f "$TMP_AGENT" "$TMP_AGENT.out"

    if [ "$kind" = gzip ]; then
      if fetch_agent "$src" && gunzip -c "$TMP_AGENT" > "$TMP_AGENT.out" 2>/dev/null \
         && [ "$(wc -c < "$TMP_AGENT.out" 2>/dev/null || echo 0)" -ge 5000 ]; then
        mv -f "$TMP_AGENT.out" "$TMP_AGENT"
        ok=1
        break
      fi
    elif [ "$kind" = base64 ]; then
      if fetch_agent "$src" && decode_base64 "$TMP_AGENT" > "$TMP_AGENT.out" 2>/dev/null \
         && [ "$(wc -c < "$TMP_AGENT.out" 2>/dev/null || echo 0)" -ge 5000 ]; then
        mv -f "$TMP_AGENT.out" "$TMP_AGENT"
        ok=1
        break
      fi
    else
      if fetch_agent "$src"; then
        ok=1
        break
      fi
    fi
    rm -f "$TMP_AGENT" "$TMP_AGENT.out"
  done

  if [ "$ok" -ne 1 ]; then
    echo "ERROR: could not download the agent from any source." >&2
    echo "       The sources tried were:" >&2
    for src in $(agent_source_urls); do echo "         $src" >&2; done
    echo "       If none of them is reachable, save agent.js on a machine that" >&2
    echo "       can and copy it over with:" >&2
    echo "         scp agent.js root@SERVER_IP:/root/agent.js" >&2
    echo "         sudo WW_PANEL_URL=... WW_AGENT_TOKEN=... bash install-agent.sh --agent-file /root/agent.js" >&2
    rm -f "$TMP_AGENT"
    exit 1
  fi
fi

install -m 0755 "$TMP_AGENT" "$WW_AGENT_DIR/agent.js"
rm -f "$TMP_AGENT"
echo "    installed to $WW_AGENT_DIR/agent.js"

# ------------------------------------------------------------------- systemd
echo "==> Writing $WW_SERVICE_NAME.service"
cat > "/etc/systemd/system/$WW_SERVICE_NAME.service" <<EOF
[Unit]
Description=WaterWall Panel Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=WW_PANEL_URL=$PANEL_URL
Environment=WW_AGENT_TOKEN=$AGENT_TOKEN
Environment=WW_AGENT_INTERVAL=$WW_AGENT_INTERVAL
Environment=WW_WATERWALL_PATH=$WW_WATERWALL_PATH
Environment=WW_SERVICE=$WW_WATERWALL_SERVICE
Environment=WW_STATE=$WW_STATE_DIR/state.json
ExecStart=$(command -v node) $WW_AGENT_DIR/agent.js
Restart=always
RestartSec=5
# The agent only needs to write its own directory and restart WaterWall.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$WW_STATE_DIR $WW_WATERWALL_PATH

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$WW_SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$WW_SERVICE_NAME"

sleep 2
echo ""
systemctl --no-pager --lines=15 status "$WW_SERVICE_NAME" || true
echo ""
echo "  Agent installed and running."
echo "  Panel : $PANEL_URL"
echo "  State : $WW_STATE_DIR/state.json"
echo "  WaterWall path: $WW_WATERWALL_PATH (service: $WW_WATERWALL_SERVICE)"
echo ""
echo "  Useful commands:"
echo "    journalctl -u $WW_SERVICE_NAME -f"
echo "    systemctl restart $WW_SERVICE_NAME"
echo ""
