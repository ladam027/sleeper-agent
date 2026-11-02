// Texts and calls to the owner via Twilio's REST API (plain fetch, no SDK).
// Credentials come from .env; this module never logs them or message bodies' secrets (bodies are agent text, already redacted).
import { createHmac, timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';
import { db, get, set, log } from './db.js';
import { recordUsd } from './budget.js';

export const deps = { fetch: (...a) => fetch(...a) }; // tests swap in a fake
const env = (k) => process.env[k] || '';
export const configured = () => !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && /^\+\d{8,15}$/.test(env('TWILIO_FROM')) && /^\+\d{8,15}$/.test(env('OWNER_PHONE')));

// ponytail: flat estimates (US rates); read real prices from Twilio's usage API if precision matters.
export const COST = { sms: 0.0083 + 0.003, call: 0.014 + 0.0083 }; // per segment incl. carrier fee / per ~1-min call + SMS-ish overhead
export const CAPS = { sms: 30, call: 5 }; // per rolling 24h; stops a loop from running up the phone bill

const sentToday = (kind) => db.prepare("select count(*) n from activity where type = ? and ts >= datetime('now', '-1 day')").get(`${kind}:out`).n;
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function twilio(resource, params) {
  const sid = env('TWILIO_ACCOUNT_SID');
  const res = await deps.fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${resource}.json`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${body.message || 'request failed'}`);
  return body;
}

async function send(kind, message) {
  if (!configured()) throw new Error('Phone not set up: add the Twilio lines to .env');
  if (sentToday(kind) >= CAPS[kind]) throw new Error(`Daily ${kind} cap (${CAPS[kind]}) reached`);
  const text = String(message).slice(0, kind === 'sms' ? 1500 : 600);
  if (kind === 'sms') await twilio('Messages', { To: env('OWNER_PHONE'), From: env('TWILIO_FROM'), Body: text });
  else await twilio('Calls', { To: env('OWNER_PHONE'), From: env('TWILIO_FROM'),
    Twiml: `<Response><Say voice="Polly.Matthew">${xml(text)}</Say><Pause length="1"/><Say voice="Polly.Matthew">Again: ${xml(text)}</Say></Response>` });
  log('phone', `${kind}:out`, text.slice(0, 200));
  recordUsd('phone', `twilio-${kind}`, COST[kind] * (kind === 'sms' ? Math.ceil(text.length / 153) : 1));
}
export const sms = (m) => send('sms', m);
export const call = (m) => send('call', m);

// "HH:MM" quiet window in the owner's timezone; handles windows that cross midnight.
export function inQuietHours(date = new Date()) {
  const [qs, qe] = [get('quiet_start') || '00:00', get('quiet_end') || '07:00'];
  const now = date.toLocaleTimeString('en-GB', { timeZone: get('timezone'), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return qs <= qe ? now >= qs && now < qe : now >= qs || now < qe;
}

// low → dashboard; high → text; critical → call + text. Agent-initiated calls become texts during quiet hours.
// opts.alarm: the owner set this call themselves, so it rings regardless of quiet hours.
export async function notify(urgency, message, opts = {}) {
  log(opts.agent || 'phone', `notify:${urgency}`, message);
  if (urgency === 'low') return 'Shown on the dashboard';
  if (!configured()) return 'Shown on the dashboard (phone not set up yet)';
  const out = [];
  try {
    if (urgency === 'critical' && (opts.alarm || !inQuietHours())) { await call(message); out.push('called'); }
    else if (urgency === 'critical') out.push('quiet hours, so no call');
    await sms(message); out.push('texted');
  } catch (e) { log('phone', 'error', e.message); out.push(`failed: ${e.message}`); }
  return `Owner ${out.join(', ')}`;
}

// Twilio request signing: HMAC-SHA1 over the full URL + POST params sorted by name, base64.
export function validSignature(url, params, signature) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const want = Buffer.from(createHmac('sha1', env('TWILIO_AUTH_TOKEN')).update(data).digest('base64'));
  const got = Buffer.from(String(signature || ''));
  return want.length === got.length && timingSafeEqual(want, got);
}
export const isOwner = (from) => !!from && from === env('OWNER_PHONE');

// SMS approval PIN, stored as a salted scrypt hash.
export function setPin(pin) {
  if (!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN must be 4-8 digits');
  const salt = randomBytes(16).toString('hex');
  set('sms_pin', `${salt}:${scryptSync(String(pin), salt, 32).toString('hex')}`);
}
export const pinSet = () => !!get('sms_pin');
export function checkPin(pin) {
  const [salt, hash] = (get('sms_pin') || '').split(':');
  if (!salt || !/^\d{4,8}$/.test(String(pin))) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(String(pin), salt, 32));
}
// "Y 12 1234" / "no #12 1234" → { approve, id, pin } or null
export function parseApproval(text) {
  const m = /^\s*(y|yes|approve|n|no|deny)\s+#?(\d+)\s+(\d{4,8})\s*$/i.exec(text || '');
  return m && { approve: /^(y|yes|approve)$/i.test(m[1]), id: Number(m[2]), pin: m[3] };
}

export const status = () => ({ configured: configured(), owner: env('OWNER_PHONE') ? '•••' + env('OWNER_PHONE').slice(-4) : null,
  publicUrl: env('PUBLIC_URL') || null, pinSet: pinSet(), quietStart: get('quiet_start') || '00:00', quietEnd: get('quiet_end') || '07:00',
  sentToday: { sms: sentToday('sms'), call: sentToday('call') }, caps: CAPS });
