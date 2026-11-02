// Encrypted vault for passwords, cards, and personal info.
//
// The key is derived from the owner's passphrase (scrypt) and lives ONLY in this process's memory after unlock.
// Nothing on disk (.env, DB, backups) can decrypt the vault, so neither the agents, Anthropic, nor anything
// with file access (including Claude Code) can read values. Viewing/editing also needs a short-lived session
// that is only issued for the passphrase (see server.js).
//
// The model never sees a value: it sees names and {{secret:name}} references, and redact() scrubs vault values,
// card numbers and SSNs from text before it is sent to the API.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, get, set, log } from './db.js';

export const KINDS = ['password', 'card', 'personal', 'api_key', 'note'];
const CHECK = 'sleeper-vault-ok';
let KEY = null; // in memory only; gone on restart or lock()

const derive = (pass, saltHex) => scryptSync(String(pass).normalize('NFKC'), Buffer.from(saltHex, 'hex'), 32,
  { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
function encrypt(key, obj) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv, tag: c.getAuthTag(), data };
}
function decrypt(key, row) {
  const d = createDecipheriv('aes-256-gcm', key, row.iv);
  d.setAuthTag(row.tag);
  return JSON.parse(Buffer.concat([d.update(row.data), d.final()]).toString('utf8'));
}
const hex = (o) => JSON.stringify({ iv: o.iv.toString('hex'), tag: o.tag.toString('hex'), data: o.data.toString('hex') });
const unhex = (s) => { const o = JSON.parse(s); return { iv: Buffer.from(o.iv, 'hex'), tag: Buffer.from(o.tag, 'hex'), data: Buffer.from(o.data, 'hex') }; };
function need() { if (!KEY) throw new Error('Vault is locked. Unlock it with your passphrase on the Vault page.'); }

export const ready = () => !!KEY;
export const status = () => ({ setup: !!get('vault_salt'), unlocked: !!KEY, items: db.prepare('select count(*) n from secrets').get().n });

export function setup(pass) {
  if (get('vault_salt')) throw new Error('Vault already has a passphrase');
  if (String(pass || '').length < 12) throw new Error('Use a passphrase of at least 12 characters');
  if (db.prepare('select count(*) n from secrets').get().n) throw new Error('Vault has items from an older key; delete them first');
  const salt = randomBytes(16).toString('hex'), key = derive(pass, salt);
  set('vault_salt', salt);
  set('vault_check', hex(encrypt(key, CHECK)));
  KEY = key; cache = null;
  log('owner', 'vault', 'passphrase set');
}

// Checks the passphrase; unlocks if locked. Throws on a wrong passphrase.
export function unlock(pass) {
  const salt = get('vault_salt');
  if (!salt) throw new Error('Set a vault passphrase first');
  const key = derive(pass, salt);
  try { if (decrypt(key, unhex(get('vault_check'))) !== CHECK) throw 0; } catch { throw new Error('Wrong passphrase'); }
  if (KEY && !timingSafeEqual(KEY, key)) throw new Error('Wrong passphrase');
  if (!KEY) log('owner', 'vault', 'unlocked');
  KEY = key; cache = null;
}

export function lock() { if (KEY) log('owner', 'vault', 'locked'); KEY = null; cache = null; }

let cache = null; // [{ name, value }] longest first, rebuilt after every change
const values = () => !KEY ? [] : cache ??= db.prepare('select * from secrets').all()
  .map((r) => ({ name: r.name, value: decrypt(KEY, r).value })).filter((s) => s.value?.length >= 4)
  .sort((a, b) => b.value.length - a.value.length);

export function save({ name, kind = 'password', value, username = '', url = '', notes = '', expiry = '', cvv = '' }) {
  need();
  if (!/^[a-z0-9_-]{2,40}$/.test(name || '')) throw new Error('Name must be 2-40 chars: lowercase letters, numbers, - or _');
  if (!KINDS.includes(kind)) throw new Error(`Kind must be one of ${KINDS.join(', ')}`);
  if (!value) throw new Error('Value is required');
  if (kind === 'card' && expiry && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry)) throw new Error('Expiry must be MM/YY');
  const { iv, tag, data } = encrypt(KEY, { value, username, url, notes, expiry, cvv });
  db.prepare(`insert into secrets (name, kind, iv, tag, data) values (?, ?, ?, ?, ?)
    on conflict(name) do update set kind = excluded.kind, iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = current_timestamp`)
    .run(name, kind, iv, tag, data);
  cache = null;
  log('owner', 'vault', `saved ${name}`); // name only, never the value
}

// details=true only for a passphrase session: adds a safe one-line summary (never the value itself).
export const list = (details = false) => db.prepare('select * from secrets order by kind, name').all().map((r) => {
  const item = { name: r.name, kind: r.kind, updated_at: r.updated_at };
  if (!details || !KEY) return item;
  const d = decrypt(KEY, r);
  const summary = r.kind === 'card' ? [d.username, d.value && `•••• ${d.value.replace(/\D/g, '').slice(-4)}`, d.expiry && `exp ${d.expiry}`]
    : r.kind === 'password' ? [d.username, d.url] : r.kind === 'api_key' ? [d.url] : [];
  return { ...item, summary: summary.filter(Boolean).join(' · ') };
});

export function reveal(name) {
  need();
  const r = db.prepare('select * from secrets where name = ?').get(name);
  return r ? { name, kind: r.kind, ...decrypt(KEY, r) } : null;
}
export function remove(name) {
  need();
  db.prepare('delete from secrets where name = ?').run(name);
  cache = null;
  log('owner', 'vault', `deleted ${name}`);
}

// What the agent may know: names and kinds only.
export const names = () => db.prepare('select name, kind from secrets order by name').all();

// For tool executors only (e.g. a browser-login tool in Build 7). The result must NEVER be returned to the model.
export const resolve = (s) => s.replace(/\{\{secret:([a-z0-9_-]+)\}\}/g, (m, n) => {
  need();
  const r = db.prepare('select * from secrets where name = ?').get(n);
  if (!r) throw new Error(`Unknown secret ${n}`);
  return decrypt(KEY, r).value;
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
// While locked, saved values can't be matched; card numbers and SSNs are still caught by pattern.
export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const s of values()) out = out.split(s.value).join(`{{secret:${s.name}}}`);
  out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => luhn(m.replace(/\D/g, '')) ? '[card number removed]' : m);
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN removed]');
  return out;
}
