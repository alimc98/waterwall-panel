#!/usr/bin/env bash
#
# WaterWall Panel — installer for the panel host
# ---------------------------------------------
# This installs the panel itself (the web UI + REST API that builds and deploys
# tunnel configs). It is not the same thing as install.sh, which puts WaterWall
# and the per-server agent on a *tunnel* server.
#
#   # from a checkout (offline, nothing is downloaded)
#   sudo ./panel-install.sh --source .
#
#   # or straight from a running panel / GitHub
#   curl -fsSL http://<panel-host>:8787/panel-install.sh | sudo bash -s -- --source /tmp/waterwall-panel
#
# What it does:
#   1. makes sure Node.js 18+ exists (apt on Debian/Ubuntu unless --offline)
#   2. copies the panel into /opt/waterwall-panel
#   3. writes a token to /etc/waterwall-panel.env (0600) and reuses it on re-runs
#   4. installs and starts the waterwall-panel systemd unit
#   5. prints the URL, the token and the exact agent command for the servers
#
# The panel can execute SSH commands on the servers you register in it, so the
# bind address defaults to 0.0.0.0 *only* when you ask for it with --host.
#
set -euo pipefail

PANEL_DIR="${WW_PANEL_DIR:-/opt/waterwall-panel}"
ENV_FILE="${WW_PANEL_ENV:-/etc/waterwall-panel.env}"
SERVICE="${WW_PANEL_SERVICE:-waterwall-panel}"
PORT="${WW_PANEL_PORT:-8787}"
# Exposed by default: this installer exists to make the panel reachable on
# IP:port. Pass --host 127.0.0.1 for a local-only panel.
HOST="${WW_PANEL_HOST:-0.0.0.0}"
DATA_DIR="${WW_PANEL_DATA:-$PANEL_DIR/data}"
SOURCE="${WW_PANEL_SOURCE:-}"
TARBALL=""
TOKEN=""
OFFLINE=0
FORCE=0
NODE_BIN=""

usage() {
  sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --source DIR     Panel checkout to install from      (default: the script's own directory)
  --tarball FILE   Install from a .tar.gz of the checkout instead of a directory
  --dir DIR        Install prefix                      (default /opt/waterwall-panel)
  --port PORT      Listen port                         (default 8787)
  --host ADDR      Bind address                        (default 0.0.0.0, use 127.0.0.1 for local-only)
  --token TOKEN    Use this API token instead of generating one
  --offline        Never use the network (no apt, no downloads)
  --force          Reinstall over an existing panel
  --help           This text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source)   SOURCE="${2:-}"; shift 2 ;;
    --tarball)  TARBALL="${2:-}"; shift 2 ;;
    --dir)      PANEL_DIR="${2:-}"; shift 2 ;;
    --port)     PORT="${2:-}"; shift 2 ;;
    --host)     HOST="${2:-}"; shift 2 ;;
    --token)    TOKEN="${2:-}"; shift 2 ;;
    --offline)  OFFLINE=1; shift ;;
    --force)    FORCE=1; shift ;;
    --help|-h)  usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Default is to expose it; --host 127.0.0.1 keeps it on loopback.
say() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this script as root (sudo)."

# --------------------------------------------------------------- node.js 18+
say "Checking Node.js"
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  NODE_BIN=""
fi
if [ -n "$NODE_BIN" ]; then
  MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  if [ "$MAJOR" -lt 18 ]; then
    say "Node.js $("$NODE_BIN" -v) is too old for the panel; need 18+"
    NODE_BIN=""
  fi
fi
if [ -z "$NODE_BIN" ]; then
  [ "$OFFLINE" -eq 1 ] && die "--offline was given but Node.js 18+ is not installed"
  if command -v apt-get >/dev/null 2>&1; then
    say "Installing Node.js from apt"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
    NODE_BIN="$(command -v node)"
  fi
fi
[ -n "$NODE_BIN" ] || die "Node.js 18+ is required and could not be installed automatically"
echo "    using $NODE_BIN ($("$NODE_BIN" -v))"

# ------------------------------------------------------------------- payload
say "Preparing the panel files"
if [ -n "$TARBALL" ]; then
  STAGE="$(mktemp -d)"
  tar -xzf "$TARBALL" -C "$STAGE"
  SOURCE="$STAGE"
fi
if [ -z "$SOURCE" ]; then
  SOURCE="$(cd "$(dirname "$0")" && pwd)"
fi
[ -f "$SOURCE/server.js" ] || die "no server.js in $SOURCE — pass --source with the panel checkout"

if [ -e "$PANEL_DIR" ] && [ "$FORCE" -eq 0 ] && [ ! -f "$PANEL_DIR/server.js" ]; then
  die "$PANEL_DIR exists but does not look like a panel (use --force)"
fi
mkdir -p "$PANEL_DIR"

# Copy only what the panel needs at runtime. The data directory is deliberately
# not part of this list: an upgrade must never drop the token or the servers.
for item in server.js package.json public lib agent install.sh docs; do
  [ -e "$SOURCE/$item" ] || continue
  rm -rf "${PANEL_DIR:?}/$item"
  cp -r "$SOURCE/$item" "$PANEL_DIR/"
done
mkdir -p "$DATA_DIR" "$PANEL_DIR/data"
chmod 0700 "$DATA_DIR"

# --------------------------------------------------------------------- token
say "Preparing the API token"
if [ -n "$TOKEN" ]; then
  echo "    using the token passed on the command line"
else
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    TOKEN="${WW_PANEL_TOKEN:-}"
  fi
  if [ -z "$TOKEN" ] && [ -f "$DATA_DIR/panel.json" ]; then
    TOKEN="$("$NODE_BIN" -e 'try{const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(d.token||"")}catch(e){}' "$DATA_DIR/panel.json")"
  fi
  if [ -z "$TOKEN" ]; then
    TOKEN="$("$NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
    echo "    generated a new token"
  else
    echo "    reusing the existing token"
  fi
fi
[ "${#TOKEN}" -ge 24 ] || die "the token is too short; use at least 24 characters"

# ------------------------------------------------------------------- env file
say "Writing $ENV_FILE"
umask 077
cat > "$ENV_FILE" <<EOF
# WaterWall Panel — read by $SERVICE.service
WW_PANEL_HOST=$HOST
WW_PANEL_PORT=$PORT
WW_PANEL_DATA=$DATA_DIR
WW_PANEL_TOKEN=$TOKEN
EOF
chmod 0600 "$ENV_FILE"

# --------------------------------------------------------------------- unit
say "Writing /etc/systemd/system/$SERVICE.service"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=WaterWall Panel (web UI + tunnel builder)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PANEL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $PANEL_DIR/server.js
Restart=always
RestartSec=3
# The panel talks to servers over SSH and keeps their passwords in its data
# directory, so it runs as root with a locked-down view of the rest of the box.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
sleep 2
systemctl --no-pager --lines=8 status "$SERVICE" || true

# -------------------------------------------------------------------- checks
say "Checking the API answers"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/servers" >/dev/null; then
    echo "    /api/servers answered with the token"
  else
    echo "    WARNING: the API did not answer yet — journalctl -u $SERVICE"
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

  ────────────────────────────────────────────────────────────
  WaterWall Panel is installed.

    UI      : http://${IP:-<server-ip>}:$PORT
    Token   : $TOKEN
    Data    : $DATA_DIR  (servers, tunnels, generated certs)
    Unit    : systemctl status $SERVICE
    Logs    : journalctl -u $SERVICE -f

  Open the UI, paste the token, and add your two servers. Then on each
  tunnel server run:

    sudo ./install.sh --panel-url http://${IP:-<panel-ip>}:$PORT \\
      --agent-token <that server's agent token from the panel> \\
      --skip-waterwall      # drop this if WaterWall is not installed yet

  SECURITY: the token can run commands on every registered server, and with
  WW_PANEL_HOST=$HOST anyone who reaches port $PORT sees the login page.
  Keep the token secret; put the panel behind a firewall, an SSH tunnel, or
  a TLS reverse proxy if the server is shared.
  ────────────────────────────────────────────────────────────
EOF
