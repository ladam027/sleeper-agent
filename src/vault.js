// Encrypted vault for passwords, cards, and personal info.
// Values are AES-256-GCM encrypted at rest with VAULT_KEY (from .env, never in the DB or git).
// The model never sees a value: it sees names and {{secret:name}} references, and redact() scrubs
// anything sensitive out of text before it is sent to the API.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { db, log } from './db.js';

const KEY = /^[0-9a-f]{64}$/i.test(process.env.VAULT_KEY || '') ? Buffer.from(process.env.VAULT_KEY, 'hex') : null;
export const ready = () => !!KEY;
export const KINDS = ['password', 'card', 'personal', 'api_key', 'note'];

function need() { if (!KEY) throw new Error('Vault is locked: set VAULT_KEY (64 hex characters) in .env and restart'); }
function encrypt(obj) {
  need();
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv, tag: c.getAuthTag(), data };
}
function decrypt(row) {
  need();
  const d = createDecipheriv('aes-256-gcm', KEY, row.iv);
  d.setAuthTag(row.tag);
  return JSON.parse(Buffer.concat([d.update(row.data), d.final()]).toString('utf8'));
}

let cache = null; // [{ name, value }] longest first, rebuilt after every change
const values = () => cache ??= !KEY ? [] : db.prepare('select * from secrets').all()
  .map((r) => ({ name: r.name, value: decrypt(r).value })).filter((s) => s.value?.length >= 4)
  .sort((a, b) => b.value.length - a.value.length);

export function save({ name, kind = 'password', value, username = '', url = '', notes = '' }) {
  if (!/^[a-z0-9_-]{2,40}$/.test(name || '')) throw new Error('Name must be 2-40 chars: lowercase letters, numbers, - or _');
  if (!KINDS.includes(kind)) throw new Error(`Kind must be one of ${KINDS.join(', ')}`);
  if (!value) throw new Error('Value is required');
  const { iv, tag, data } = encrypt({ value, username, url, notes });
  db.prepare(`insert into secrets (name, kind, iv, tag, data) values (?, ?, ?, ?, ?)
    on conflict(name) do update set kind = excluded.kind, iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = current_timestamp`)
    .run(name, kind, iv, tag, data);
  cache = null;
  log('owner', 'vault', `saved ${name}`); // name only, never the value
}

// For the dashboard (owner only). Usernames/urls are shown, values are not.
export const list = () => db.prepare('select * from secrets order by kind, name').all().map((r) => {
  const { username, url } = KEY ? decrypt(r) : {};
  return { name: r.name, kind: r.kind, username, url, updated_at: r.updated_at };
});
export function reveal(name) {
  const r = db.prepare('select * from secrets where name = ?').get(name);
  return r ? { name, kind: r.kind, ...decrypt(r) } : null;
}
export function remove(name) {
  db.prepare('delete from secrets where name = ?').run(name);
  cache = null;
  log('owner', 'vault', `deleted ${name}`);
}

// What the agent may know: names and kinds only.
export const names = () => db.prepare('select name, kind from secrets order by name').all();

// For tool executors only (e.g. a browser-login tool in Build 7). The result must NEVER be returned to the model.
export const resolve = (s) => s.replace(/\{\{secret:([a-z0-9_-]+)\}\}/g, (m, n) => {
  const r = db.prepare('select * from secrets where name = ?').get(n);
  if (!r) throw new Error(`Unknown secret ${n}`);
  return decrypt(r).value;
});

const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

// Runs on everything headed to the API: user messages, system prompt, tool results.
export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const s of values()) out = out.split(s.value).join(`{{secret:${s.name}}}`);
  out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => luhn(m.replace(/\D/g, '')) ? '[card number removed]' : m);
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN removed]');
  return out;
}
