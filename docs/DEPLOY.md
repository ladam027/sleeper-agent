# Running Sleeper Agent 24/7

Pick one. Both keep the dashboard private (Tailscale); nothing is exposed to the internet.

## Option A: your Mac (free, simplest)
1. System Settings → Battery/Energy → "Prevent automatic sleeping when the display is off" (on power). Lid closed = asleep unless an external display is attached.
2. Keep it running and restarting on crash with launchd:
   ```bash
   cat > ~/Library/LaunchAgents/com.sleeper-agent.plist <<PLIST
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>com.sleeper-agent</string>
     <key>WorkingDirectory</key><string>$HOME/Documents/Claude Agent</string>
     <key>ProgramArguments</key><array><string>$(which node)</string><string>--env-file=.env</string><string>src/server.js</string></array>
     <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>/tmp/sleeper-agent.log</string><key>StandardErrorPath</key><string>/tmp/sleeper-agent.log</string>
   </dict></plist>
   PLIST
   launchctl load ~/Library/LaunchAgents/com.sleeper-agent.plist
   ```
   Restart after an update: `launchctl kickstart -k gui/$(id -u)/com.sleeper-agent`

## Option B: a small VPS (~$5/mo, truly 24/7)
Ubuntu, Node 24+, then:
```bash
git clone https://github.com/ladam027/sleeper-agent.git && cd sleeper-agent && npm ci
# copy .env over securely (scp), never paste it anywhere
sudo tee /etc/systemd/system/sleeper-agent.service <<UNIT
[Service]
WorkingDirectory=$PWD
ExecStart=$(which node) --env-file=.env src/server.js
Restart=always
User=$USER
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now sleeper-agent
```
Copy your existing `data/agent.db` over too if you want your chats and memory there.

## Both: Tailscale for private access
```bash
tailscale up                  # dashboard reachable from your phone/laptop on your tailnet
tailscale serve --bg 8787     # https://<machine>.<tailnet>.ts.net → dashboard (tailnet only)
```
Nothing needs to be public: Telegram is polled and Telnyx calls carry their own instructions. Never funnel 8787.

**After every restart the vault is locked.** Open the dashboard → Vault → enter your passphrase. Card numbers and SSNs are still filtered while it's locked.
