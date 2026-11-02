#!/usr/bin/env bash
# Deploy Sleeper Agent to a VPS over SSH. No GitHub access needed on the server (code is rsynced).
#   First time:   npm run deploy -- root@1.2.3.4 --setup   (installs Node, Tailscale, firewall, systemd)
#   Move data:    npm run deploy -- --move                  (stops the Mac server, copies .env + database, starts the VPS)
#   Updates:      npm run deploy                            (code only, then restart)
set -euo pipefail
cd "$(dirname "$0")/.."
ARGS=()
for a in "$@"; do case "$a" in --setup) SETUP=1 ;; --move) MOVE=1 ;; *) ARGS+=("$a") ;; esac; done
HOST="${ARGS[0]:-$(cat .vps-host 2>/dev/null || true)}"
[ -n "$HOST" ] || { echo "Usage: npm run deploy -- root@YOUR_SERVER_IP --setup"; exit 1; }
echo "$HOST" > .vps-host
APP=/opt/sleeper-agent

if [ -n "${SETUP:-}" ]; then
  echo "→ Setting up $HOST"
  ssh -o StrictHostKeyChecking=accept-new "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq rsync ufw xz-utils >/dev/null
id sleeper >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/sleeper-agent --shell /usr/sbin/nologin sleeper
# Node from nodejs.org, checksum verified
if ! /usr/local/bin/node -v 2>/dev/null | grep -qE '^v(2[6-9]|[3-9][0-9])'; then
  BASE=https://nodejs.org/dist/latest-v26.x
  curl -fsSL "$BASE/SHASUMS256.txt" -o /tmp/SHASUMS256.txt
  case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "Unsupported CPU $(uname -m)"; exit 1 ;; esac
  TAR=$(grep -o "node-v[0-9.]*-linux-$ARCH.tar.xz" /tmp/SHASUMS256.txt | head -1)
  curl -fsSL "$BASE/$TAR" -o "/tmp/$TAR"
  (cd /tmp && grep " $TAR\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "/tmp/$TAR" -C /usr/local --strip-components=1
fi
# Firewall: SSH only. The dashboard listens on 127.0.0.1 and is reached through Tailscale.
ufw allow OpenSSH >/dev/null && ufw --force enable >/dev/null
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
cat > /etc/systemd/system/sleeper-agent.service <<UNIT
[Unit]
Description=Sleeper Agent
After=network-online.target
Wants=network-online.target
[Service]
User=sleeper
WorkingDirectory=/opt/sleeper-agent
ExecStart=/usr/local/bin/node --env-file=.env src/server.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable sleeper-agent >/dev/null
echo "Node $(/usr/local/bin/node -v), Tailscale $(tailscale version | head -1)"
REMOTE
fi

echo "→ Uploading code"
rsync -az --delete --exclude node_modules --exclude data --exclude .git --exclude .env --exclude .vps-host --exclude .claude ./ "$HOST:$APP/"

if [ -n "${MOVE:-}" ]; then
  echo "→ Stopping the Mac server and snapshotting the database"
  PID=$(lsof -ti tcp:8787 -sTCP:LISTEN || true); [ -n "$PID" ] && kill $PID && sleep 1
  SNAP=$(mktemp -d)/agent.db
  node -e "new (require('node:sqlite').DatabaseSync)('data/agent.db').exec(\"vacuum into '$SNAP'\")"
  ssh "$HOST" "mkdir -p $APP/data"
  rsync -az .env "$HOST:$APP/.env"
  rsync -az "$SNAP" "$HOST:$APP/data/agent.db"
  rm -f "$SNAP"
fi

echo "→ Installing and restarting"
ssh "$HOST" "cd $APP && chown -R sleeper:sleeper $APP && chmod 600 $APP/.env 2>/dev/null; sudo -u sleeper -H /usr/local/bin/npm ci --omit=dev --silent && systemctl restart sleeper-agent && sleep 2 && systemctl is-active sleeper-agent && journalctl -u sleeper-agent -n 5 --no-pager -o cat"
echo "✓ Deployed $(node -p "require('./package.json').version") to $HOST"
