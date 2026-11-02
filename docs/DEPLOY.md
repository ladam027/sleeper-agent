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

## Option B: a small VPS (~$7/mo, truly 24/7)
1. Create an Ubuntu 24.04 server (e.g. Hetzner CX23 at ~$6.49 + $0.50 IPv4, in an EU location if CX isn't offered in the US; or DigitalOcean's $6 droplet). Paste your Mac's public key (`pbcopy < ~/.ssh/id_ed25519.pub`) as the SSH key.
2. `npm run deploy -- root@SERVER_IP --setup` installs Node (checksum-verified from nodejs.org), Tailscale, a firewall allowing only SSH, and a systemd service that runs as an unprivileged `sleeper` user.
3. `npm run deploy -- --move` stops the Mac server, copies `.env` and a consistent snapshot of `data/agent.db`, and starts it on the VPS. **Don't run `npm start` on the Mac again**: two copies would both answer Telegram and both fire reminders.
4. On the server: `ssh root@SERVER_IP tailscale up` (open the printed link to log in), then `ssh root@SERVER_IP tailscale serve --bg 8787`. Open the printed `https://…ts.net` address on any device signed in to your tailnet.
5. Later updates: `npm run deploy` (code only, then restart). Logs: `ssh root@SERVER_IP journalctl -u sleeper-agent -f`.

## Both: Tailscale for private access
```bash
tailscale up                  # dashboard reachable from your phone/laptop on your tailnet
tailscale serve --bg 8787     # https://<machine>.<tailnet>.ts.net → dashboard (tailnet only)
```
Nothing needs to be public: Telegram is polled and Telnyx calls carry their own instructions. Never funnel 8787.

**After every restart the vault is locked.** Open the dashboard → Vault → enter your passphrase. Card numbers and SSNs are still filtered while it's locked.
