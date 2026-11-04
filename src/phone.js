// Reaching the owner: Telegram messages (free, two-way) and Telnyx phone calls (alarms, emergencies).
// Neither needs SMS registration or a public URL: calls carry inline TeXML, Telegram is polled (see telegram.js).
// Credentials come from .env and are never logged.
import { timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';
import { db, get, set, log } from './db.js';
import { recordUsd } from './budget.js';

export const deps = { fetch: (...a) => fetch(...a) }; // tests swap in a fake
const env = (k) => process.env[k] || '';
const e164 = (n) => /^\+\d{8,15}$/.test(n);
export const callsReady = () => !!(env('TELNYX_API_KEY') && env('TELNYX_CONNECTION_ID') && e164(env('TELNYX_FROM')) && e164(env('OWNER_PHONE')));
export const telegramReady = () => !!(env('TELEGRAM_BOT_TOKEN') && get('telegram_chat_id'));

// ponytail: flat estimate for a ~1 min US call with TTS; read Telnyx usage reports if precision matters.
export const COST = { call: 0.01, msg: 0 };
export const CAPS = { msg: 100, call: 5 }; // per rolling 24h; stops a loop from spamming you or running up the phone bill

const sentToday = (kind) => db.prepare("select count(*) n from activity where type = ? and ts >= datetime('now', '-1 day')").get(`${kind}:out`).n;
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Telegram with a file (photos for CAPTCHAs). fields are strings (JSON for objects).
export async function telegramFile(method, fields, fileField, buffer, filename) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'string' ? v : String(v));
  form.append(fileField, new Blob([buffer], { type: 'image/jpeg' }), filename);
  const res = await deps.fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram: ${body.description || res.status}`);
  return body.result;
}
export async function telegram(method, params) {
  const res = await deps.fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: params.signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram: ${body.description || res.status}`);
  return body.result;
}

function guard(kind, ready, what) {
  if (!ready) throw new Error(`${what} not set up yet (see Settings → Phone & alerts)`);
  if (sentToday(kind) >= CAPS[kind]) throw new Error(`Daily ${kind === 'msg' ? 'message' : 'call'} cap (${CAPS[kind]}) reached`);
}

export async function message(text, chatId = get('telegram_chat_id')) {
  guard('msg', env('TELEGRAM_BOT_TOKEN') && chatId, 'Telegram');
  const body = String(text).slice(0, 4000);
  await telegram('sendMessage', { chat_id: chatId, text: body });
  log('phone', 'msg:out', body.slice(0, 200));
}

export async function call(text) {
  guard('call', callsReady(), 'Phone calls');
  const say = xml(String(text).slice(0, 600));
  const res = await deps.fetch(`https://api.telnyx.com/v2/texml/calls/${encodeURIComponent(env('TELNYX_CONNECTION_ID'))}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env('TELNYX_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ From: env('TELNYX_FROM'), To: env('OWNER_PHONE'),
      Texml: `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew-Neural">${say}</Say><Pause length="1"/><Say voice="Polly.Matthew-Neural">Again. ${say}</Say></Response>` }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(`Telnyx ${res.status}: ${b.errors?.[0]?.detail || b.errors?.[0]?.title || 'call failed'}`); }
  log('phone', 'call:out', String(text).slice(0, 200));
  recordUsd('phone', 'telnyx-call', COST.call);
}

// "HH:MM" quiet window in the owner's timezone; handles windows that cross midnight.
export function inQuietHours(date = new Date()) {
  const [qs, qe] = [get('quiet_start') || '00:00', get('quiet_end') || '07:00'];
  const now = date.toLocaleTimeString('en-GB', { timeZone: get('timezone'), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return qs <= qe ? now >= qs && now < qe : now >= qs || now < qe;
}

// Where is the owner? Active on the dashboard = tab visible + input in the last 2 min (reported by the page).
// Working from the phone = messaged the bot in the last 15 min, which wins over an open dashboard.
export const DASHBOARD_ACTIVE_MS = 2 * 60e3, PHONE_RECENT_MS = 15 * 60e3;
export function ownerOnDashboard(now = Date.now()) {
  const onDash = now - Number(get('dashboard_active_at') || 0) < DASHBOARD_ACTIVE_MS;
  const onPhone = get('last_owner_channel') === 'telegram' && now - Number(get('last_owner_channel_at') || 0) < PHONE_RECENT_MS;
  return onDash && !onPhone;
}
export const ownerUsed = (channel) => { set('last_owner_channel', channel); set('last_owner_channel_at', Date.now()); };

// low → dashboard; high → Telegram; critical → call + Telegram. Agent-initiated calls become messages during quiet hours.
// While the owner is active on the dashboard, Telegram messages are skipped: the dashboard shows the alert instead.
// opts.alarm: the owner set this call themselves, so it rings regardless of quiet hours.
// opts.explicit: the owner chose this delivery (their own reminders), so it always goes out as chosen.
export async function notify(urgency, text, opts = {}) {
  log(opts.agent || 'phone', `notify:${urgency}`, text);
  if (urgency === 'low') return 'Shown on the dashboard';
  const atDesk = !opts.explicit && ownerOnDashboard();
  if (atDesk && urgency === 'high') return 'Shown on the dashboard (the owner is active there right now)';
  const out = [];
  if (urgency === 'critical') {
    if (!callsReady()) out.push('calls not set up');
    else if (!opts.alarm && inQuietHours()) out.push('quiet hours, so no call');
    else try { await call(text); out.push('called'); } catch (e) { log('phone', 'error', e.message); out.push(`call failed: ${e.message}`); }
  }
  if (atDesk) out.push('shown on the dashboard (owner is active there)');
  else if (telegramReady()) try { await message(text); out.push('messaged on Telegram'); } catch (e) { log('phone', 'error', e.message); out.push(`message failed: ${e.message}`); }
  else out.push('shown on the dashboard (Telegram not set up)');
  return `Owner ${out.join(', ')}`;
}

// Approval PIN (required for approvals sent from the phone), stored as a salted scrypt hash.
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

export const status = () => ({
  calls: callsReady(), owner: env('OWNER_PHONE') ? '•••' + env('OWNER_PHONE').slice(-4) : null,
  telegramToken: !!env('TELEGRAM_BOT_TOKEN'), telegramPaired: !!get('telegram_chat_id'),
  pinSet: pinSet(), quietStart: get('quiet_start') || '00:00', quietEnd: get('quiet_end') || '07:00',
  sentToday: { msg: sentToday('msg'), call: sentToday('call') }, caps: CAPS,
});
