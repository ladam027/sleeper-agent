import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { db, get, set, log, backup, lastBackup, SCHEMA_VERSION } from './db.js';
import * as vault from './vault.js';
import { summary, PRICES } from './budget.js';
import { TOOLS } from './tools.js';
import { runAgent, auto, kill, restart, decide } from './agent.js';


const TOKEN = process.env.DASHBOARD_TOKEN;
if (!TOKEN || TOKEN.length < 16) throw new Error('Set DASHBOARD_TOKEN (16+ chars) in .env');
const HOST = process.env.HOST || '127.0.0.1'; // keep local; reach it remotely through Tailscale, not the open internet
const PORT = Number(process.env.PORT || 8787);
const page = new URL('../public/index.html', import.meta.url);

// Version shown in Settings. Major = build number (PLAN.md §4), minor = update within that build.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const git = (...a) => { try { return execFileSync('git', a, { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim(); } catch { return null; } };
const VERSION = { version: pkg.version, build: Number(pkg.version.split('.')[0]), update: Number(pkg.version.split('.')[1]),
  commit: git('rev-parse', '--short', 'HEAD'), commits: Number(git('rev-list', '--count', 'HEAD')) || null, schema: SCHEMA_VERSION, started: new Date().toISOString() };
backup('startup');

const authed = (req) => {
  const got = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
};

async function body(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 1e6) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

const SETTINGS = ['timezone', 'global_daily_budget_usd', 'global_halt'];

// Vault sessions: issued only for the passphrase, kept in memory, 15 minutes sliding. The dashboard token
// alone (which is on disk in .env) can list item names but never see or change vault contents.
const sessions = new Map(), failures = [];
const newSession = () => { const t = randomBytes(32).toString('hex'); sessions.set(t, Date.now() + 15 * 60e3); return t; };
function hasSession(req) {
  const t = req.headers['x-vault-session'], exp = t && sessions.get(t);
  if (!exp || exp < Date.now() || !vault.ready()) { if (t) sessions.delete(t); return false; }
  sessions.set(t, Date.now() + 15 * 60e3);
  return true;
}

async function api(req, url) {
  const [, , route, id, action] = url.pathname.split('/'); // /api/<route>/<id>/<action>
  const m = req.method;

  if (route === 'state' && m === 'GET') return {
    agents: db.prepare('select * from agents order by name').all(),
    approvals: db.prepare("select * from approvals where status = 'pending' order by id").all(),
    activity: db.prepare('select * from activity order by id desc limit 150').all(),
    costs: summary(),
    settings: Object.fromEntries(SETTINGS.map((k) => [k, get(k)])),
    version: { ...VERSION, lastBackup: lastBackup() },
    vault: vault.status(),
    stats: db.prepare(`select (select count(*) from memory) memories, (select count(*) from memory where pinned = 1) pinned,
      (select count(*) from activity where type = 'task' and ts >= datetime('now', '-1 day')) tasks24h,
      (select count(*) from activity where type = 'tool' and ts >= datetime('now', '-1 day')) tools24h`).get(),
    chat: db.prepare("select * from (select * from chat where agent = ? order by id desc limit 50) order by id").all(url.searchParams.get('agent') === 'auto' ? 'orchestrator' : url.searchParams.get('agent') || 'orchestrator'),
    prices: PRICES,
  };
  if (route === 'chat' && m === 'POST') {
    const { agent = 'auto', text } = await body(req);
    if (!text?.trim()) throw new Error('text required');
    return { reply: await (agent === 'auto' ? auto(text.slice(0, 20000)) : runAgent(agent, text.slice(0, 20000))) };
  }
  if (route === 'approvals' && m === 'POST') {
    const result = await decide(Number(id), (await body(req)).approve === true);
    return result === null ? { error: 'not pending' } : { result };
  }
  if (route === 'agents' && m === 'POST') {
    if (action === 'kill') return kill(id), { ok: true };
    if (action === 'restart') return restart(id), { ok: true };
    const b = await body(req), upd = (col, v) => db.prepare(`update agents set ${col} = ? where name = ?`).run(v, id);
    if (b.daily_budget_usd !== undefined) { if (!(b.daily_budget_usd >= 0 && b.daily_budget_usd <= 50)) throw new Error('Daily budget must be $0–50'); upd('daily_budget_usd', b.daily_budget_usd); }
    if (b.effort !== undefined) { if (!['low', 'medium', 'high'].includes(b.effort)) throw new Error('Effort must be low, medium or high'); upd('effort', b.effort); }
    if (b.concise !== undefined) upd('concise', b.concise ? 1 : 0);
    if (b.display_name !== undefined) { const v = String(b.display_name).trim(); if (!/^[\p{L}\p{N} .'-]{1,24}$/u.test(v)) throw new Error('Name must be 1-24 letters, numbers or spaces'); upd('display_name', v); }
    if (b.max_tokens !== undefined) { if (!(b.max_tokens >= 512 && b.max_tokens <= 64000)) throw new Error('Max reply length must be 512–64000 tokens'); upd('max_tokens', Math.round(b.max_tokens)); }
    log('owner', 'settings', `${id}: ${Object.keys(b).join(', ')} updated`);
    return { ok: true };
  }
  if (route === 'settings' && m === 'POST') {
    const b = await body(req);
    if (b.timezone) TOOLS.set_timezone.run({ timezone: b.timezone });
    if (b.global_daily_budget_usd >= 0) set('global_daily_budget_usd', b.global_daily_budget_usd);
    if ('global_halt' in b) { set('global_halt', b.global_halt ? 1 : 0); log('owner', 'halt', b.global_halt ? 'ON' : 'off'); }
    return { ok: true };
  }
  if (route === 'vault-auth' && m === 'POST') {
    if (id === 'lock') { vault.lock(); sessions.clear(); return { ok: true }; }
    if (failures.filter((t) => Date.now() - t < 5 * 60e3).length >= 5) throw new Error('Too many wrong passphrases. Wait 5 minutes.');
    const { passphrase } = await body(req);
    try { id === 'setup' ? vault.setup(passphrase) : vault.unlock(passphrase); }
    catch (e) { if (e.message === 'Wrong passphrase') { failures.push(Date.now()); log('owner', 'vault', 'wrong passphrase attempt'); } throw e; }
    return { session: newSession() };
  }
  if (route === 'vault') {
    const ok = hasSession(req);
    if (m === 'GET' && !id) return { status: vault.status(), session: ok, items: vault.list(ok) };
    if (!ok) throw new Error('Vault session expired. Enter your passphrase again.');
    if (m === 'GET') return vault.reveal(decodeURIComponent(id)) || { error: 'not found' };
    if (m === 'POST') return vault.save(await body(req)), { ok: true };
    if (m === 'DELETE') return vault.remove(decodeURIComponent(id)), { ok: true };
  }
  if (route === 'backup' && m === 'POST') return { file: backup('manual') };
  if (route === 'memory') {
    if (m === 'GET') return {
      nodes: db.prepare('select * from memory order by id').all(),
      links: db.prepare('select * from links').all(),
    };
    if (m === 'POST') return { result: TOOLS.remember.run(await body(req)) };
    if (m === 'DELETE') {
      db.prepare('delete from links where src = ? or dst = ?').run(id, id);
      db.prepare('delete from memory where id = ?').run(id);
      return { ok: true };
    }
  }
  return { error: 'not found' };
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(readFileSync(page));
  }
  if (!authed(req)) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
  let out;
  try { out = await api(req, url); }
  catch (e) { out = { error: e.message }; }
  res.writeHead(out.error ? 400 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
}).listen(PORT, HOST, () => console.log(`Sleeper Agent dashboard: http://${HOST}:${PORT}`));
