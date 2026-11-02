// Integrations: third-party services whose credentials live in the encrypted vault.
// Agents get tools; the credential is read from the vault here, at call time, and never returned.
// (Tool results also pass through redact(), which blanks any vault value as a second safeguard.)
import { sign, createPrivateKey, constants } from 'node:crypto';
import * as vault from './vault.js';
import { log } from './db.js';

export const deps = { fetch: (...a) => fetch(...a) }; // tests swap in a fake

// fields map onto vault entry fields: value (the secret), username, url, notes.
export const INTEGRATIONS = {
  canvas: {
    name: 'Canvas', vault: 'canvas', category: 'School',
    blurb: "Upcoming assignments, due dates and current grades from your school's Canvas.",
    fields: [{ key: 'url', label: 'Canvas address', placeholder: 'https://elearn.ucr.edu' }, { key: 'value', label: 'Access token', secret: true }],
    help: 'In Canvas: Account → Settings → "+ New Access Token". Give it a purpose like "Sleeper Agent" and an expiry date, then paste it here.',
    tools: ['canvas_upcoming', 'canvas_grades'],
  },
  kalshi: {
    name: 'Kalshi', vault: 'kalshi', category: 'Markets',
    blurb: 'Read-only: your balance, positions, and open markets. No trading until Build 6, and then only with your approval on every order.',
    fields: [{ key: 'username', label: 'API key ID' }, { key: 'value', label: 'Private key (the whole PEM file)', secret: true, multiline: true }],
    help: 'In Kalshi: Account → Profile → API Keys → Create. Kalshi shows the private key once: paste the whole thing, including the BEGIN/END lines.',
    tools: ['kalshi_portfolio', 'kalshi_markets'],
  },
  schwab: {
    name: 'Charles Schwab', vault: 'schwab', category: 'Markets',
    blurb: 'Stores your Schwab developer app credentials now. Read-only portfolio access comes in Build 6, once Schwab approves your app.',
    fields: [{ key: 'username', label: 'App key' }, { key: 'value', label: 'App secret', secret: true }],
    help: 'Apply at developer.schwab.com → create an app for "Accounts and Trading Production" with callback URL https://sleeper-agent.tailcdfa9.ts.net/oauth/schwab. Approval takes a few days.',
    tools: [], comingSoon: 'Build 6',
  },
};

export function status() {
  const have = new Set(vault.names().map((n) => n.name));
  return Object.fromEntries(Object.entries(INTEGRATIONS).map(([id, d]) => [id, { saved: have.has(d.vault) }]));
}

export function save(id, input) {
  const d = INTEGRATIONS[id];
  if (!d) throw new Error('Unknown integration');
  const entry = { name: d.vault, kind: 'api_key', notes: `${d.name} integration` };
  for (const f of d.fields) entry[f.key] = String(input[f.key] || '').trim();
  if (id === 'canvas') entry.url = canvasBase(entry.url);
  if (id === 'kalshi') try { createPrivateKey(entry.value); } catch { throw new Error("That doesn't look like a valid private key. Paste the whole PEM, including the BEGIN and END lines."); }
  vault.save(entry); // vault.save throws if locked, logs the name only
  return `${d.name} saved to the vault`;
}

// Read credentials for a tool. Throws a plain explanation the agent can relay.
function creds(id) {
  const d = INTEGRATIONS[id];
  if (!vault.ready()) throw new Error(`The vault is locked, so ${d.name} can't be used right now. Ask the owner to unlock it on the dashboard.`);
  const c = vault.reveal(d.vault);
  if (!c?.value) throw new Error(`${d.name} isn't connected. The owner can add it on the Integrations page.`);
  return c;
}

async function getJson(url, headers, what) {
  const res = await deps.fetch(url, { headers: { accept: 'application/json', ...headers } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${what} returned ${res.status}${res.status === 401 ? ' (the saved key was rejected; it may have expired)' : ''}`);
  return j;
}

// ── Canvas ──
function canvasBase(url) {
  let u; try { u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`); } catch { throw new Error('Enter your Canvas address, e.g. https://elearn.ucr.edu'); }
  if (u.protocol !== 'https:') throw new Error('Canvas address must start with https://');
  return u.origin;
}
const canvas = (path) => { const c = creds('canvas'); return getJson(`${canvasBase(c.url)}/api/v1${path}`, { authorization: `Bearer ${c.value}` }, 'Canvas'); };
const short = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Titles, courses and dates only: no descriptions, which anyone with course access can write.
export async function canvasUpcoming() {
  const [events, todo] = await Promise.all([canvas('/users/self/upcoming_events?per_page=50'), canvas('/users/self/todo?per_page=50').catch(() => [])]);
  const items = [
    ...events.map((e) => ({ title: short(e.title), course: short(e.context_name, 60), type: e.assignment ? 'assignment' : 'event', due: e.assignment?.due_at || e.start_at || null })),
    ...todo.filter((t) => t.assignment).map((t) => ({ title: short(t.assignment.name), course: short(t.context_name, 60), type: 'to-do', due: t.assignment.due_at || null })),
  ];
  const seen = new Set();
  return items.filter((i) => { const k = `${i.title}|${i.due}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
}
export async function canvasGrades() {
  const courses = await canvas('/courses?enrollment_state=active&include[]=total_scores&per_page=50');
  return courses.filter((c) => c.name).map((c) => {
    const e = (c.enrollments || []).find((x) => x.type === 'student') || {};
    return { course: short(c.name, 80), current_score: e.computed_current_score ?? null, current_grade: e.computed_current_grade ?? null };
  });
}

// ── Kalshi (read-only) ──
const KALSHI = 'https://external-api.kalshi.com';
export function kalshiHeaders(method, path, c, now = Date.now()) {
  const key = createPrivateKey(c.value), ts = String(now);
  const msg = Buffer.from(ts + method + path); // path without query string, per Kalshi docs
  const sig = key.asymmetricKeyType === 'ed25519' ? sign(null, msg, key)
    : sign('sha256', msg, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  return { 'KALSHI-ACCESS-KEY': c.username, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig.toString('base64') };
}
async function kalshi(path, query = '') {
  const c = creds('kalshi'), full = `/trade-api/v2${path}`;
  return getJson(`${KALSHI}${full}${query ? `?${query}` : ''}`, kalshiHeaders('GET', full, c), 'Kalshi');
}
export async function kalshiPortfolio() {
  const [bal, pos] = await Promise.all([kalshi('/portfolio/balance'), kalshi('/portfolio/positions', 'limit=100')]);
  return { balance_usd: (bal.balance ?? 0) / 100, positions: (pos.market_positions || []).filter((p) => p.position).map((p) => ({ ticker: p.ticker, position: p.position, exposure_usd: (p.market_exposure ?? 0) / 100, realized_pnl_usd: (p.realized_pnl ?? 0) / 100 })) };
}
export async function kalshiMarkets({ series_ticker, event_ticker, search, limit = 20 } = {}) {
  const q = new URLSearchParams({ status: 'open', limit: String(Math.min(search ? 200 : limit, 200)) });
  if (series_ticker) q.set('series_ticker', series_ticker);
  if (event_ticker) q.set('event_ticker', event_ticker);
  const j = await kalshi('/markets', q.toString());
  const words = String(search || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (j.markets || []).filter((m) => words.every((w) => `${m.title} ${m.subtitle || ''} ${m.ticker}`.toLowerCase().includes(w)))
    .slice(0, limit).map((m) => ({ ticker: m.ticker, title: short(m.title), yes_bid: m.yes_bid, yes_ask: m.yes_ask, last_price: m.last_price, volume: m.volume, closes: m.close_time }));
}

// Dashboard "Test" button: a cheap authenticated call.
export async function test(id) {
  if (id === 'canvas') { const me = await canvas('/users/self'); log('owner', 'settings', 'Canvas test OK'); return `Connected as ${short(me.name, 60)}`; }
  if (id === 'kalshi') { const b = await kalshi('/portfolio/balance'); log('owner', 'settings', 'Kalshi test OK'); return `Connected. Balance $${((b.balance ?? 0) / 100).toFixed(2)}`; }
  if (id === 'schwab') { creds('schwab'); return 'Saved. Schwab sign-in arrives in Build 6.'; }
  throw new Error('Unknown integration');
}
