import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { db, get, set, log } from './db.js';
import { summary } from './budget.js';
import { TOOLS } from './tools.js';
import { runAgent, kill, restart, decide } from './agent.js';

const TOKEN = process.env.DASHBOARD_TOKEN;
if (!TOKEN || TOKEN.length < 16) throw new Error('Set DASHBOARD_TOKEN (16+ chars) in .env');
const HOST = process.env.HOST || '127.0.0.1'; // keep local; reach it remotely through Tailscale, not the open internet
const PORT = Number(process.env.PORT || 8787);
const page = new URL('../public/index.html', import.meta.url);

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

async function api(req, url) {
  const [, , route, id, action] = url.pathname.split('/'); // /api/<route>/<id>/<action>
  const m = req.method;

  if (route === 'state' && m === 'GET') return {
    agents: db.prepare('select * from agents order by name').all(),
    approvals: db.prepare("select * from approvals where status = 'pending' order by id").all(),
    activity: db.prepare('select * from activity order by id desc limit 150').all(),
    costs: summary(),
    settings: Object.fromEntries(SETTINGS.map((k) => [k, get(k)])),
    chat: db.prepare("select * from (select * from chat where agent = ? order by id desc limit 50) order by id").all(url.searchParams.get('agent') || 'orchestrator'),
  };
  if (route === 'chat' && m === 'POST') {
    const { agent = 'orchestrator', text } = await body(req);
    if (!text?.trim()) throw new Error('text required');
    return { reply: await runAgent(agent, text.slice(0, 20000)) };
  }
  if (route === 'approvals' && m === 'POST') {
    const result = await decide(Number(id), (await body(req)).approve === true);
    return result === null ? { error: 'not pending' } : { result };
  }
  if (route === 'agents' && m === 'POST') {
    if (action === 'kill') return kill(id), { ok: true };
    if (action === 'restart') return restart(id), { ok: true };
    const { daily_budget_usd } = await body(req);
    if (daily_budget_usd >= 0) db.prepare('update agents set daily_budget_usd = ? where name = ?').run(daily_budget_usd, id);
    return { ok: true };
  }
  if (route === 'settings' && m === 'POST') {
    const b = await body(req);
    if (b.timezone) TOOLS.set_timezone.run({ timezone: b.timezone });
    if (b.global_daily_budget_usd >= 0) set('global_daily_budget_usd', b.global_daily_budget_usd);
    if ('global_halt' in b) { set('global_halt', b.global_halt ? 1 : 0); log('owner', 'halt', b.global_halt ? 'ON' : 'off'); }
    return { ok: true };
  }
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
