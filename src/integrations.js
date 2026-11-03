// Integrations: third-party services whose credentials live in the encrypted vault.
// Agents get tools; the credential is read from the vault here, at call time, and never returned.
// (Tool results also pass through redact(), which blanks any vault value as a second safeguard.)
import { sign, createPrivateKey, constants } from 'node:crypto';
import * as vault from './vault.js';
import { db, get, log } from './db.js';
import { localToUtc } from './scheduler.js';

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
  let res;
  for (let attempt = 0; ; attempt++) { // back off on rate limits (429) and brief outages
    res = await deps.fetch(url, { headers: { accept: 'application/json', ...headers } });
    if (![429, 502, 503].includes(res.status) || attempt >= 4) break;
    const wait = Number(res.headers?.get?.('retry-after')) * 1000 || 500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
  }
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
// Kalshi now reports money as dollar strings (e.g. "0.3600"); older fields were integer cents. Accept both.
const usd = (dollars, cents) => dollars != null ? Number(dollars) : cents != null ? cents / 100 : null;

export async function kalshiPortfolio() {
  const [bal, pos] = await Promise.all([kalshi('/portfolio/balance'), kalshi('/portfolio/positions', 'limit=100')]);
  return { balance_usd: usd(bal.balance_dollars, bal.balance) ?? 0,
    positions: (pos.market_positions || []).map((p) => ({ ticker: p.ticker, position: Number(p.position_fp ?? p.position ?? 0), exposure_usd: usd(p.market_exposure_dollars, p.market_exposure) ?? 0, realized_pnl_usd: usd(p.realized_pnl_dollars, p.realized_pnl) ?? 0 }))
      .filter((p) => p.position) };
}

// Public market data: no key needed, so it works even while the vault is locked.
async function kalshiPublic(path, query = '') {
  return getJson(`${KALSHI}/trade-api/v2${path}${query ? `?${query}` : ''}`, {}, 'Kalshi');
}
const cache = {
  get: (k) => { const r = db.prepare('select value from cache where key = ?').get(k); return r ? JSON.parse(r.value) : undefined; },
  set: (k, v) => db.prepare('insert or replace into cache (key, value) values (?, ?)').run(k, JSON.stringify(v)),
};

export async function kalshiMarkets({ series_ticker, event_ticker, search, limit = 20 } = {}) {
  const q = new URLSearchParams({ status: 'open', limit: String(Math.min(search ? 200 : limit, 200)) });
  if (series_ticker) q.set('series_ticker', series_ticker);
  if (event_ticker) q.set('event_ticker', event_ticker);
  const j = await kalshiPublic('/markets', q.toString());
  const words = String(search || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (j.markets || []).filter((m) => words.every((w) => `${m.title} ${m.yes_sub_title || ''} ${m.ticker}`.toLowerCase().includes(w)))
    .slice(0, limit).map((m) => ({ ticker: m.ticker, title: short(m.title), bracket: m.yes_sub_title || null, yes_bid: usd(m.yes_bid_dollars, m.yes_bid), yes_ask: usd(m.yes_ask_dollars, m.yes_ask),
      last_price: usd(m.last_price_dollars, m.last_price), volume: Number(m.volume_fp ?? m.volume ?? 0), closes: m.close_time }));
}

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const eventDate = (eventTicker) => { const m = /-(\d{2})([A-Z]{3})(\d{2})$/.exec(eventTicker || ''); return m && MONTHS[m[2]] ? `20${m[1]}-${MONTHS[m[2]]}-${m[3]}` : null; };

// For backtests: every settled market in a series over the last N days, with the price at a chosen local time
// (e.g. 10:00 on the event day, or the evening before) and how it settled. Settled data never changes, so it's cached.
export async function kalshiBacktestData({ series_ticker, days = 30, at_local_time = '10:00', day_offset = 0, tz } = {}) {
  if (!/^[A-Z0-9]+$/.test(series_ticker || '')) throw new Error('series_ticker is required, e.g. KXHIGHLAX');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at_local_time)) throw new Error('at_local_time must be HH:MM');
  days = Math.min(Math.max(Number(days) || 30, 1), 90);
  tz = tz || get('timezone');
  const since = Date.now() - days * 864e5, markets = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const j = await kalshiPublic('/markets', new URLSearchParams({ series_ticker, status: 'settled', limit: '200', ...(cursor ? { cursor } : {}) }).toString());
    for (const m of j.markets || []) if (Date.parse(m.close_time) >= since) markets.push(m);
    cursor = j.cursor;
    if (!cursor || (j.markets || []).some((m) => Date.parse(m.close_time) < since)) break;
  }
  const rows = [];
  for (let i = 0; i < markets.length; i += 3) { // a few at a time, to stay under Kalshi's rate limits
    await Promise.all(markets.slice(i, i + 3).map(async (m) => {
      const date = eventDate(m.event_ticker);
      if (!date) return;
      const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(day_offset));
      const at = Math.floor(localToUtc(`${d.toISOString().slice(0, 10)}T${at_local_time}`, tz).getTime() / 1000);
      const key = `kalshi:${m.ticker}:${at}`;
      let snap = cache.get(key);
      if (snap === undefined) {
        const c = await kalshiPublic(`/series/${series_ticker}/markets/${m.ticker}/candlesticks`, `start_ts=${at - 3 * 3600}&end_ts=${at}&period_interval=60`);
        const last = (c.candlesticks || []).filter((x) => x.end_period_ts <= at).at(-1);
        snap = last ? { yes_bid: usd(last.yes_bid?.close_dollars), yes_ask: usd(last.yes_ask?.close_dollars), last: usd(last.price?.close_dollars), volume: Number(last.volume_fp ?? 0) } : null;
        cache.set(key, snap);
      }
      rows.push({ date, bracket: m.yes_sub_title || m.ticker.split('-').pop(), ticker: m.ticker, result: m.result, ...(snap || { yes_bid: null, yes_ask: null, last: null, volume: 0 }) });
    }));
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || String(a.bracket).localeCompare(String(b.bracket)));
  const byDay = {};
  for (const r of rows) (byDay[r.date] ||= []).push(r);
  const favorites = Object.entries(byDay).map(([date, rs]) => { const f = rs.filter((r) => r.yes_ask != null).sort((a, b) => b.yes_ask - a.yes_ask)[0];
    return f ? { date, favorite: f.bracket, ask: f.yes_ask, won: f.result === 'yes' } : { date, favorite: null }; });
  return { series_ticker, snapshot: `${at_local_time} ${tz}, day offset ${day_offset}`, days: Object.keys(byDay).length, markets: rows.length,
    note: 'Prices are in dollars per $1 contract at the snapshot time. yes_ask is what buying YES would have cost. Kalshi fees are not included.', favorites, rows };
}

// Official daily weather records (NOAA NCEI, free, no key). Kalshi's LA highs (KXHIGHLAX) match LAX (USW00023174):
// checked against the winning brackets for Oct 26-30, 2026. Downtown LA (USW00093134) runs several degrees hotter.
export async function weatherHistory({ station = 'USW00023174', start, end }) {
  if (!/^[A-Z0-9]{11}$/.test(station)) throw new Error('station must be a GHCN-Daily id like USW00093134');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) throw new Error('start and end must be YYYY-MM-DD');
  if ((Date.parse(end) - Date.parse(start)) / 864e5 > 400) throw new Error('At most about a year at a time');
  const j = await getJson('https://www.ncei.noaa.gov/access/services/data/v1?' + new URLSearchParams({ dataset: 'daily-summaries', stations: station,
    startDate: start, endDate: end, dataTypes: 'TMAX,TMIN,PRCP', units: 'standard', format: 'json' }), {}, 'NOAA');
  return { station, source: 'NOAA NCEI daily summaries (official; the most recent few days may not be published yet)',
    days: (Array.isArray(j) ? j : []).map((d) => ({ date: d.DATE, high_f: d.TMAX != null ? Number(d.TMAX) : null, low_f: d.TMIN != null ? Number(d.TMIN) : null, precip_in: d.PRCP != null ? Number(d.PRCP) : null })) };
}

// Dashboard "Test" button: a cheap authenticated call.
export async function test(id) {
  if (id === 'canvas') { const me = await canvas('/users/self'); log('owner', 'settings', 'Canvas test OK'); return `Connected as ${short(me.name, 60)}`; }
  if (id === 'kalshi') { const b = await kalshi('/portfolio/balance'); log('owner', 'settings', 'Kalshi test OK'); return `Connected. Balance $${((b.balance ?? 0) / 100).toFixed(2)}`; }
  if (id === 'schwab') { creds('schwab'); return 'Saved. Schwab sign-in arrives in Build 6.'; }
  throw new Error('Unknown integration');
}
