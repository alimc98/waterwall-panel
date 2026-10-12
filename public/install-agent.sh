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
echo "==> Downloading the agent from $PANEL_URL"
AGENT_URL="$PANEL_URL/agent.js"
TMP_AGENT="$(mktemp)"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$AGENT_URL" -o "$TMP_AGENT"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_AGENT" "$AGENT_URL"
else
  echo "ERROR: neither curl nor wget is available." >&2
  exit 1
fi

if [ ! -s "$TMP_AGENT" ]; then
  echo "ERROR: could not download the agent from $AGENT_URL" >&2
  exit 1
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
