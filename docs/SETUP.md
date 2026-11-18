# Setting up Sleeper Agent

You need Node 24 or newer, an Anthropic API key, and about 15 minutes for the basics. Everything after step 4 is optional and can be added at any time.

## 1. Install and run locally
```bash
git clone <this repo> sleeper-agent && cd sleeper-agent
cp .env.example .env
npm install
npm test
```
Edit `.env`:
- `ANTHROPIC_API_KEY`: from console.anthropic.com → API keys. Set a monthly spend limit there too.
- `DASHBOARD_TOKEN`: a long random string (`openssl rand -hex 24`). It's the dashboard password.
- Leave `HOST=127.0.0.1`. The dashboard should never listen on a public address.

```bash
npm start
```
Open http://127.0.0.1:8787 and enter your `DASHBOARD_TOKEN`.

## 2. First steps in the dashboard
1. **Vault → Set passphrase** (12+ characters). The vault holds passwords, cards and API keys, encrypted with a key derived from this passphrase. It is never stored, so **if you lose it, the vault can't be recovered**. The vault locks on every restart and after an idle hour.
2. **Settings:** set your timezone and daily/monthly budget caps. Spending is enforced in code; agents stop when a cap is hit.
3. **Chat with James** (Overview): tell him your name and what you want help with. He saves it to memory.

## 3. Phone: Telegram (messages and approvals)
1. In Telegram, message **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN` in `.env`, then restart.
2. Dashboard → **Settings → Pair Telegram** and send the 6-digit code to your bot.
3. Set an approval PIN in Settings. Approving from the phone is `Y <id> <PIN>`.

Optional phone calls for critical alerts (Telnyx): create an account, buy a number, put the API key in `TELNYX_API_KEY` and your cell in `OWNER_PHONE` (E.164, e.g. `+15555551234`), then run `npm run setup:telnyx`.

## 4. Run it 24/7
See [DEPLOY.md](DEPLOY.md). In short, either keep a Mac awake with launchd, or use a small VPS:
```bash
npm run deploy -- root@SERVER_IP --setup   # first time: Node, Tailscale, firewall, systemd service
npm run deploy -- --move                   # moves .env and the database from this machine to the server
npm run deploy                             # every later update (runs the tests first)
```
Reach the dashboard from your phone with Tailscale (`tailscale serve --bg 8787`), never with a public port. Run only one copy at a time, or both will answer Telegram.

## 5. Google: James's Gmail, your calendar, Drive (optional)
1. Create a separate Google account for James (his outbox and inbox).
2. At console.cloud.google.com, signed in as yourself: create a project, then enable the **Gmail**, **Google Calendar** and **Google Drive** APIs.
3. Set up the OAuth consent screen (External) and add both accounts as test users. Then **publish it** ("In production"). In Testing mode Google expires the sign-in after 7 days.
4. Create an OAuth client (Web application). Redirect URI: `<PUBLIC_DASHBOARD_URL>/oauth/google`, where `PUBLIC_DASHBOARD_URL` is your Tailscale dashboard address, e.g. `https://my-machine.my-tailnet.ts.net`.
5. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_DASHBOARD_URL` in `.env` and restart. Then go to Settings → Google and connect James's account and your own.

## 6. Integrations (optional, dashboard → Integrations)
Keys are saved to the vault, so unlock it first.
- **Netlify** (publishing websites): User settings → Applications → Personal access token.
- **OpenAI Images** (image generation): an API key with billing enabled.
- **Ayrshare** (social posts): an API key, with your social profiles linked on their site.
- **Canvas** (school assignments and grades): your school's Canvas address and an access token from Account → Settings.
- **Kalshi / Charles Schwab** (markets): developer credentials. Trading stays paper-only unless you explicitly switch it on.

## 7. Income engine (optional, Money → Income engine)
Finds local businesses without a website, builds a demo site, and drafts a pitch email for your approval. Fill in your name, area, offer and a mailing address (US law requires one in sales emails; a P.O. box works). It needs Netlify and James's Gmail. Nothing is sent until you approve it.

## The browser, video and PDFs
The agents' web browser uses Chromium through `playwright-core`. Video and PDF tools use `ffmpeg` and `pdftotext`. `npm run deploy` installs all of these on the server. To use them locally:
```bash
npx playwright-core install chromium
brew install ffmpeg poppler
```

## Safety defaults
- Anything that sends, posts, pays, trades, creates an account or publishes waits for your approval.
- Secrets live only in `.env` and the vault. Vault values, card numbers and SSNs are removed before anything reaches the model.
- Email, web pages and files are treated as untrusted. They can't choose tools, recipients, URLs or amounts on their own.
- The kill switch (top of the dashboard) stops every agent immediately.
