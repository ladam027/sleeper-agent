// Google: James's own Gmail (send approved emails, watch his inbox) and, optionally, the owner's
// Gmail (read-only digest) + Calendar. OAuth "web" client; the redirect lands on the private Tailscale URL.
// Plain fetch, no SDK. Refresh tokens live in the settings table (same trust level as .env); never logged.
import { randomBytes } from 'node:crypto';
import { get, set, log } from './db.js';

export const deps = { fetch: (...a) => fetch(...a) }; // tests swap in a fake
const env = (k) => process.env[k] || '';
export const ACCOUNTS = {
  james: { scopes: ['https://www.googleapis.com/auth/gmail.modify'], label: "James's Gmail" },
  owner: { scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events'], label: 'Your Gmail (read-only) + Calendar' },
};
const redirectUri = () => `${env('PUBLIC_DASHBOARD_URL').replace(/\/$/, '')}/oauth/google`;
export const configured = () => !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET') && env('PUBLIC_DASHBOARD_URL'));
const stored = (acct) => { try { return JSON.parse(get(`google_${acct}`) || 'null'); } catch { return null; } };
export const connected = (acct) => !!stored(acct)?.refresh_token;
export const status = () => ({ configured: configured(), redirectUri: configured() ? redirectUri() : null,
  james: stored('james')?.email || null, owner: stored('owner')?.email || null });

// Step 1: dashboard asks for a sign-in link. State is single-use and expires in 10 minutes.
const pending = new Map();
export function authUrl(acct) {
  if (!configured()) throw new Error('Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_DASHBOARD_URL to .env first');
  if (!ACCOUNTS[acct]) throw new Error('Unknown account');
  const state = randomBytes(24).toString('hex');
  pending.set(state, { acct, exp: Date.now() + 10 * 60e3 });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: redirectUri(), response_type: 'code', access_type: 'offline', prompt: 'consent',
    include_granted_scopes: 'false', scope: ACCOUNTS[acct].scopes.join(' '), state });
}

async function token(params) {
  const res = await deps.fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), ...params }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}`);
  return j;
}

// Step 2: Google redirects back with ?code&state.
export async function finishAuth(code, state) {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.exp < Date.now()) throw new Error('This sign-in link expired. Start again from Settings.');
  const t = await token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.');
  const missing = ACCOUNTS[p.acct].scopes.filter((s) => !String(t.scope).split(' ').includes(s));
  if (missing.length) throw new Error('Some permissions were not granted. Tick every box on the Google screen and try again.');
  access.set(p.acct, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
  const profile = await api(p.acct, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
  set(`google_${p.acct}`, JSON.stringify({ email: profile.emailAddress, refresh_token: t.refresh_token }));
  log('owner', 'settings', `${ACCOUNTS[p.acct].label} connected (${profile.emailAddress})`);
  return { acct: p.acct, email: profile.emailAddress };
}
export function disconnect(acct) { set(`google_${acct}`, ''); access.delete(acct); log('owner', 'settings', `${ACCOUNTS[acct]?.label} disconnected`); }

const access = new Map(); // acct -> { token, exp } in memory only
async function accessToken(acct) {
  const a = access.get(acct);
  if (a && a.exp > Date.now()) return a.token;
  const s = stored(acct);
  if (!s?.refresh_token) throw new Error(`${ACCOUNTS[acct].label} is not connected (Settings → Google)`);
  const t = await token({ refresh_token: s.refresh_token, grant_type: 'refresh_token' });
  access.set(acct, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
  return t.access_token;
}
async function api(acct, url, opts = {}) {
  const res = await deps.fetch(url, { ...opts, headers: { authorization: `Bearer ${await accessToken(acct)}`, 'content-type': 'application/json', ...opts.headers } });
  const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${res.status}: ${j.error?.message || 'request failed'}`);
  return j;
}

// ── Gmail ──
const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const header = (m, name) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
// Metadata + snippet only: enough for summaries, and far less attacker text than full bodies.
export async function listMail(acct, query, max = 15) {
  const list = await api(acct, `${G}/messages?` + new URLSearchParams({ q: query, maxResults: String(Math.min(max, 50)) }));
  const out = [];
  for (const { id } of list.messages || []) {
    const m = await api(acct, `${G}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    out.push({ id, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet || '', unread: (m.labelIds || []).includes('UNREAD') });
  }
  return out;
}
export const markRead = (acct, id) => api(acct, `${G}/messages/${id}/modify`, { method: 'POST', body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) });

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encWord = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
export function mime({ from, to, subject, body }) {
  if (!/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(to || '')) throw new Error(`Not a valid email address: ${to}`);
  if (/[\r\n]/.test(subject)) throw new Error('Subject cannot contain line breaks');
  return [`From: ${from}`, `To: ${to}`, `Subject: ${encWord(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', Buffer.from(body, 'utf8').toString('base64')].join('\r\n');
}
// Sends from JAMES's account only. Callers are approval-gated (send_email is high risk) or the owner's own click.
export async function sendAsJames({ to, subject, body }) {
  const from = stored('james')?.email;
  if (!from) throw new Error("James's Gmail is not connected (Settings → Google)");
  const r = await api('james', `${G}/messages/send`, { method: 'POST', body: JSON.stringify({ raw: b64url(mime({ from, to, subject, body })) }) });
  log('james', 'email:out', `to ${to}: ${subject.slice(0, 100)}`);
  return r.id;
}

// ── Calendar (owner's primary calendar) ──
const C = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
export async function events(days = 7) {
  const now = new Date();
  const j = await api('owner', `${C}?` + new URLSearchParams({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + days * 864e5).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '50' }));
  return (j.items || []).map((e) => ({ id: e.id, title: e.summary || '(no title)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location || '' }));
}
export async function addEvent({ title, start, end, description = '', location = '' }) {
  const tz = get('timezone'), isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s), isTime = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);
  if (!title?.trim()) throw new Error('Event needs a title');
  if (!(isDay(start) || isTime(start)) || (end && !(isDay(end) || isTime(end)))) throw new Error('start/end must be YYYY-MM-DD (all day) or YYYY-MM-DDTHH:MM (owner local time)');
  const when = (s) => isDay(s) ? { date: s } : { dateTime: `${s}:00`, timeZone: tz };
  const endAt = end || (isDay(start) ? start : new Date(Date.parse(`${start}:00Z`) + 3600e3).toISOString().slice(0, 16)); // default 1 hour
  const e = await api('owner', C, { method: 'POST', body: JSON.stringify({ summary: title.slice(0, 200), description: description.slice(0, 2000), location: location.slice(0, 200), start: when(start), end: when(endAt) }) });
  log('owner', 'calendar', `added "${title.slice(0, 80)}" ${start}`);
  return `Added to your calendar: ${title} (${start})`;
}
