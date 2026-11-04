import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { db, get, set, log, backup, lastBackup, SCHEMA_VERSION } from './db.js';
import * as vault from './vault.js';
import * as phone from './phone.js';
import * as scheduler from './scheduler.js';
import * as telegram from './telegram.js';
import * as jobs from './jobs.js';
import * as money from './money.js';
import * as google from './google.js';
import * as integrations from './integrations.js';
import { stats } from './stats.js';
import * as studio from './studio.js';
import * as paper from './paper.js';
import * as browser from './browser.js';
import * as live from './live.js';
import * as tasks from './tasks.js';
import * as drive from './drive.js';
import { TOOLS, capabilities } from './tools.js';
import { summary, PRICES, addBoost, boost, globalCap } from './budget.js';
import { runAgent, auto, kill, restart, decide, getSummary, runWaiting } from './agent.js';


const TOKEN = process.env.DASHBOARD_TOKEN;
if (!TOKEN || TOKEN.length < 16) throw new Error('Set DASHBOARD_TOKEN (16+ chars) in .env');
const HOST = process.env.HOST || '127.0.0.1'; // keep local; reach it remotely through Tailscale, not the open internet
const PORT = Number(process.env.PORT || 8787);
const page = new URL('../public/index.html', import.meta.url);
const VIEWS = /^\/(overview|memory|vault|money|markets|clients|browser|studio|stats|integrations|guide|settings)?\/?$/;

// Version shown in Settings. Major = build number (PLAN.md §4), minor = update within that build.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
// Commit info: from git locally, from .build-info.json on the VPS (written by scripts/deploy.sh; no .git there).
const buildInfo = (() => { try { return JSON.parse(readFileSync(new URL('../.build-info.json', import.meta.url))); } catch { return {}; } })();
const git = (...a) => { try { return execFileSync('git', a, { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const VERSION = { version: pkg.version, build: Number(pkg.version.split('.')[0]), update: Number(pkg.version.split('.')[1]),
  commit: git('rev-parse', '--short', 'HEAD') || buildInfo.commit || null, commits: Number(git('rev-list', '--count', 'HEAD')) || buildInfo.commits || null, schema: SCHEMA_VERSION, started: new Date().toISOString() };
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

const SETTINGS = ['timezone', 'global_daily_budget_usd', 'global_halt', 'digest_time', 'history_limit', 'browser_review'];

// Vault sessions: issued only for the passphrase, kept in memory, 1 hour sliding. The dashboard token
// alone (which is on disk in .env) can list item names but never see or change vault contents.
const sessions = new Map(), failures = [];
const SESSION_MS = 60 * 60e3;
const newSession = () => { const t = randomBytes(32).toString('hex'); sessions.set(t, Date.now() + SESSION_MS); return t; };
function hasSession(req) {
  const t = req.headers['x-vault-session'], exp = t && sessions.get(t);
  if (!exp || exp < Date.now() || !vault.ready()) { if (t) sessions.delete(t); return false; }
  sessions.set(t, Date.now() + SESSION_MS);
  return true;
}

let lastActiveWrite = 0;
async function api(req, url) {
  // The page reports real use (visible tab + recent input); used to keep alerts off the phone while the owner is at the desk.
  if (req.headers['x-owner-active'] === '1' && Date.now() - lastActiveWrite > 20e3) { lastActiveWrite = Date.now(); set('dashboard_active_at', lastActiveWrite); }
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
    google: google.status(),
    integrations: { defs: integrations.INTEGRATIONS, status: integrations.status(), anthropic: !!process.env.ANTHROPIC_API_KEY },
    phone: phone.status(),
    boosts: Object.fromEntries([['global', boost('global')], ...db.prepare('select name from agents').all().map((a) => [a.name, boost(a.name)])]),
    globalCap: globalCap(),
    reminders: scheduler.upcoming(),
    stats: db.prepare(`select (select count(*) from memory) memories, (select count(*) from memory where pinned = 1) pinned,
      (select count(*) from activity where type = 'task' and ts >= datetime('now', '-1 day')) tasks24h,
      (select count(*) from activity where type = 'tool' and ts >= datetime('now', '-1 day')) tools24h`).get(),
    tasks: tasks.list(),
    chat: db.prepare("select * from (select * from chat where agent = ? order by id desc limit 50) order by id").all(url.searchParams.get('agent') === 'auto' ? 'orchestrator' : url.searchParams.get('agent') || 'orchestrator'),
    prices: PRICES,
    chatSummary: getSummary(url.searchParams.get('agent') === 'auto' || !url.searchParams.get('agent') ? 'orchestrator' : url.searchParams.get('agent')),
    tools: Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, { risk: t.risk, hidden: t.hidden, description: t.def.description.split('. ')[0] }])),
  };
  if (route === 'chat' && m === 'POST') {
    const { agent = 'auto', text } = await body(req);
    if (!text?.trim()) throw new Error('text required');
    phone.ownerUsed('dashboard'); set('dashboard_active_at', lastActiveWrite = Date.now());
    return { reply: await (agent === 'auto' ? auto(text.slice(0, 20000), { owner: true }) : runAgent(agent, text.slice(0, 20000), 0, { owner: true })) };
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
    if (b.flex_min !== undefined) {
      const ag = db.prepare('select model from agents where name = ?').get(id), tiers = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5'];
      if (b.flex_min !== '' && !(tiers.includes(b.flex_min) && tiers.indexOf(b.flex_min) < tiers.indexOf(ag?.model))) throw new Error('Flexible model must be cheaper than the agent\'s model');
      upd('flex_min', b.flex_min);
    }
    if (b.effort !== undefined) { if (!['low', 'medium', 'high'].includes(b.effort)) throw new Error('Effort must be low, medium or high'); upd('effort', b.effort); }
    if (b.concise !== undefined) upd('concise', b.concise === true ? 1 : [0, 1, 2].includes(Number(b.concise)) ? Number(b.concise) : 0);
    if (b.tools !== undefined) {
      if (!Array.isArray(b.tools) || b.tools.some((t) => !TOOLS[t])) throw new Error('Unknown tool');
      if (id !== 'orchestrator' && b.tools.some((t) => ['create_agent', 'delegate', 'apply_memory_cleanup'].includes(t))) throw new Error('Only the orchestrator may create agents or delegate');
      upd('tools', b.tools.join(','));
    }
    if (b.web !== undefined) upd('web', b.web ? 1 : 0);
    if (b.project !== undefined) upd('project_id', money.projectId(b.project));
    if (b.display_name !== undefined) { const v = String(b.display_name).trim(); if (!/^[\p{L}\p{N} .'-]{1,24}$/u.test(v)) throw new Error('Name must be 1-24 letters, numbers or spaces'); upd('display_name', v); }
    if (b.max_tokens !== undefined) { if (!(b.max_tokens >= 512 && b.max_tokens <= 64000)) throw new Error('Max reply length must be 512–64000 tokens'); upd('max_tokens', Math.round(b.max_tokens)); }
    log('owner', 'settings', `${id}: ${Object.keys(b).join(', ')} updated`);
    return { ok: true };
  }
  if (route === 'settings' && m === 'POST') {
    const b = await body(req);
    if (b.timezone) TOOLS.set_timezone.run({ timezone: b.timezone });
    if (b.global_daily_budget_usd >= 0) set('global_daily_budget_usd', b.global_daily_budget_usd);
    for (const k of ['quiet_start', 'quiet_end']) if (b[k] !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b[k])) throw new Error('Quiet hours must be HH:MM'); set(k, b[k]); }
    if (b.history_limit !== undefined) { const n = Number(b.history_limit); if (!(n >= 2 && n <= 40)) throw new Error('History must be 2-40 messages'); set('history_limit', Math.round(n)); }
    if (b.browser_review !== undefined) { if (!['sam', 'owner'].includes(b.browser_review)) throw new Error('browser_review must be sam or owner'); set('browser_review', b.browser_review); log('owner', 'settings', `browser steps reviewed by ${b.browser_review}`); }
    if (b.digest_time !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.digest_time)) throw new Error('Briefing time must be HH:MM'); set('digest_time', b.digest_time); }
    if (b.sms_pin) { phone.setPin(b.sms_pin); log('owner', 'settings', 'SMS PIN changed'); }
    if ('global_halt' in b) { set('global_halt', b.global_halt ? 1 : 0); log('owner', 'halt', b.global_halt ? 'ON' : 'off'); }
    return { ok: true };
  }
  if (route === 'vault-auth' && m === 'POST') {
    if (id === 'lock') { vault.lock(); sessions.clear(); return { ok: true }; }
    if (failures.filter((t) => Date.now() - t < 5 * 60e3).length >= 5) throw new Error('Too many wrong passphrases. Wait 5 minutes.');
    const { passphrase } = await body(req);
    try { id === 'setup' ? vault.setup(passphrase) : vault.unlock(passphrase); }
    catch (e) { if (e.message === 'Wrong passphrase') { failures.push(Date.now()); log('owner', 'vault', 'wrong passphrase attempt'); } throw e; }
    runWaiting().catch((e) => log('owner', 'error', `waiting orders: ${e.message}`)); // approved live orders that waited for the unlock
    return { session: newSession() };
  }
  if (route === 'vault') {
    const ok = hasSession(req);
    if (m === 'GET' && !id) return { status: vault.status(), session: ok, items: vault.list(ok) };
    if (!ok) throw new Error('Vault session expired. Enter your passphrase again.');
    if (m === 'GET') return vault.reveal(decodeURIComponent(id)) || { error: 'not found' };
    if (m === 'POST' && id === 'idle') return vault.setIdleHours((await body(req)).hours), { ok: true };
    if (m === 'POST') return vault.save(await body(req)), { ok: true };
    if (m === 'DELETE') return vault.remove(decodeURIComponent(id)), { ok: true };
  }
  if (route === 'backup' && m === 'POST') return { file: backup('manual') };
  if (route === 'drive' && m === 'GET') return drive.recent();
  if (route === 'tasks') {
    if (m === 'GET') return { tasks: tasks.list() };
    if (m === 'POST') return { result: tasks.setStatus(Number(id), (await body(req)).status) };
  }
  if (route === 'runs' && m === 'GET') {
    // Whole task = the run plus every sub-agent run under it.
    const tree = `with recursive t(id) as (select ? union all select r.id from runs r join t on r.parent = t.id) select id from t`;
    if (id) return { steps: db.prepare(`select ts, agent, type, detail from activity where run_id in (${tree}) and type not in ('llm') order by id`).all(Number(id)),
      calls: db.prepare(`select ts, agent, model, input, output, cache_read, cache_write, usd from costs where run_id in (${tree}) order by id`).all(Number(id)) };
    const rows = db.prepare("select * from runs where parent is null order by id desc limit 40").all();
    return { runs: rows.map((r) => { const tot = db.prepare(`select count(*) steps, coalesce(sum(usd), 0) usd, coalesce(sum(input), 0) i, coalesce(sum(output), 0) o, coalesce(sum(cache_read), 0) cr, coalesce(sum(cache_write), 0) cw from costs where run_id in (${tree})`).get(r.id);
      const waiting = db.prepare(`select tool from approvals where status in ('pending', 'waiting_unlock') and run_id in (${tree}) limit 1`).get(r.id);
      return { ...r, steps: tot.steps, usd: tot.usd, input: tot.i, output: tot.o, cache_read: tot.cr, cache_write: tot.cw, waiting: waiting ? `your approval (${waiting.tool.replace(/_/g, ' ')})` : null }; }) };
  }
  if (route === 'capabilities' && m === 'GET') return capabilities();
  if (route === 'browser' && m === 'POST' && action === 'input') return browser.ownerInput(id, await body(req));
  if (route === 'browser' && m === 'GET') return id ? (await browser.preview(id)) || { error: 'That browser session has closed' } : { sessions: browser.openSessions() };
  if (route === 'markets') { // read-only view + the owner's limits; agents can't change limits
    if (m === 'GET') return { paper: await paper.account(), live: await integrations.kalshiPortfolio().catch((e) => ({ error: e.message })), days_required: paper.PAPER_DAYS, live_orders: live.recent(), live_cap: live.cap(),
      autopilot: get('paper_auto_task') ? db.prepare('select id, status, local_time, due_at, max_usd, last_run, last_result, runs from tasks where id = ?').get(Number(get('paper_auto_task'))) || null : null };
    if (m === 'POST' && id === 'autopilot') { const b = await body(req); return { task: tasks.update(Number(get('paper_auto_task')), { time: b.time, max_usd: b.max_usd === undefined ? undefined : Number(b.max_usd), status: b.status }) }; }
    if (m === 'POST' && id === 'limits') { const b = await body(req); if (b.live_max_total_usd !== undefined) live.setCap(b.live_max_total_usd); delete b.live_max_total_usd; return paper.setLimits(b), { ok: true }; }
  }
  if (route === 'studio') { // owner's own clicks: publishing from here is the approval
    if (m === 'GET' && !id) return { sites: studio.listSites(), posts: studio.listPosts(), platforms: studio.PLATFORMS,
      netlify: vault.names().some((n) => n.name === 'netlify'), ayrshare: vault.names().some((n) => n.name === 'ayrshare'), vaultUnlocked: vault.ready() };
    if (m === 'GET' && id === 'site') return { html: studio.inlineImages(studio.siteHtml(decodeURIComponent(action))) || '' };
    if (m === 'GET' && id === 'preview-link') { const slug = decodeURIComponent(action); return { path: `/p/${encodeURIComponent(slug)}/${studio.previewToken(slug)}` }; }
    const b = await body(req);
    if (id === 'publish-site') return { result: await studio.publishSite(b.slug) };
    if (id === 'delete-site') { db.prepare('delete from sites where slug = ?').run(b.slug); log('owner', 'site', `deleted draft ${b.slug}`); return { ok: true }; }
    if (id === 'post') {
      if (b.action === 'publish') return { result: await studio.publishPost(Number(b.id)) };
      if (!['posted', 'discarded'].includes(b.action)) throw new Error('Unknown action');
      db.prepare('update posts set status = ? where id = ?').run(b.action, Number(b.id)); return { ok: true };
    }
  }
  if (route === 'stats' && m === 'GET') return stats(url.searchParams.get('span') || '7d');
  if (route === 'boost' && m === 'POST') { // the owner's own click: raise a limit for today, no approval needed
    const { target, extra } = await body(req);
    if (target !== 'global' && !db.prepare('select 1 from agents where name = ?').get(target)) throw new Error('Unknown agent');
    if (!(extra > 0 && extra <= 50)) throw new Error('Extra must be between $0 and $50');
    const total = addBoost(target, extra);
    log('owner', 'budget', `${target} limit raised by $${extra} for today (extra today: $${total})`);
    return { ok: true, total };
  }
  if (route === 'phone' && m === 'POST' && id === 'test') {
    const { kind } = await body(req);
    if (kind === 'call') await phone.call('This is Sleeper Agent. Your phone calls are working.');
    else await phone.message('Sleeper Agent: Telegram is working. Message me here to talk to James and Pete.');
    return { ok: true };
  }
  if (route === 'telegram' && m === 'POST') {
    if (id === 'pair') return { code: telegram.startPairing() };
    if (id === 'unpair') return telegram.unpair(), { ok: true };
  }
  if (route === 'reminders') {
    if (m === 'POST') return { result: scheduler.addReminder(await body(req), 'owner') };
    if (m === 'DELETE') return { result: scheduler.cancelReminder(Number(id)) };
  }
  if (route === 'money') {
    if (m === 'GET') return { ...money.moneySummary(), contacts: money.listContacts(), drafts: money.listDrafts(), stages: money.STAGES };
    const b = await body(req);
    if (id === 'project') return { result: money.upsertProject(b) };
    if (id === 'entry' && m === 'POST') return { result: money.logMoney(b, 'owner') };
    if (id === 'entry' && m === 'DELETE') { db.prepare('delete from ledger where id = ?').run(Number(b.id)); log('owner', 'money', `deleted entry #${b.id}`); return { ok: true }; }
    if (id === 'contact') return { result: money.upsertContact(b) };
    if (id === 'draft' && m === 'POST') return { result: money.saveDraft(b, 'owner') };
    if (id === 'draft-send') { // the owner's own click is the approval
      const d = db.prepare("select * from drafts where id = ? and status = 'draft'").get(Number(b.id));
      if (!d) throw new Error('Draft not found or already sent');
      await google.sendAsJames({ to: b.to || d.to_addr, subject: d.subject, body: d.body });
      money.markDraftSent(d.id);
      return { ok: true };
    }
    if (id === 'draft-status') { if (!['sent', 'discarded'].includes(b.status)) throw new Error('status must be sent or discarded');
      db.prepare('update drafts set status = ? where id = ?').run(b.status, Number(b.id)); return { ok: true }; }
    if (id === 'goal') { if (!(b.goal > 0)) throw new Error('Goal must be positive'); set('monthly_income_goal', b.goal); return { ok: true }; }
  }
  if (route === 'integrations' && m === 'POST') {
    if (action === 'test') return { result: await integrations.test(id) };
    if (!hasSession(req)) throw new Error('Vault session expired. Unlock the vault (Vault page) to save credentials.');
    return { result: integrations.save(id, await body(req)) };
  }
  if (route === 'google' && m === 'POST') {
    const { account } = await body(req);
    if (id === 'connect') return { url: google.authUrl(account) };
    if (id === 'disconnect') return google.disconnect(account), { ok: true };
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

scheduler.start();
telegram.poll(); // no-op until TELEGRAM_BOT_TOKEN is set
jobs.start();
tasks.start(runAgent, phone.notify);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pv = /^\/p\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)$/.exec(url.pathname); // private draft link (tailnet only; token per site)
  if (pv) {
    const html = studio.previewHtml(pv[1], pv[2]);
    if (!html) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, studio.PREVIEW_HEADERS); return res.end(studio.inlineImages(html));
  }
  if (url.pathname === '/oauth/google') { // Google redirects the browser here; the single-use state proves we started it
    let msg;
    try { const r = await google.finishAuth(url.searchParams.get('code'), url.searchParams.get('state')); msg = `Connected ${r.email}. You can close this tab.`; }
    catch (e) { msg = url.searchParams.get('error') ? `Google sign-in was cancelled (${url.searchParams.get('error')}).` : e.message; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Google</title><body style="font:16px system-ui;padding:40px;max-width:520px;margin:auto"><h2>Sleeper Agent</h2><p>${msg.replace(/[<>&]/g, '')}</p><p><a href="/">Back to the dashboard</a></p>`);
  }
  // Each dashboard tab has its own address (/vault, /markets, …); all of them are the same single page.
  if (!url.pathname.startsWith('/api/')) {
    if (!VIEWS.test(url.pathname)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' });
    return res.end(readFileSync(page));
  }
  if (!authed(req)) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
  // Build 8: chat with the reply streamed as newline-delimited JSON ({"d": text piece} …, then {"reply"} or {"error"}).
  if (url.pathname === '/api/chat-stream' && req.method === 'POST') {
    let b; try { b = await body(req); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
    const text = String(b.text || '').trim().slice(0, 20000), agentName = b.agent || 'auto';
    if (!text) { res.writeHead(400); return res.end('{"error":"text required"}'); }
    phone.ownerUsed('dashboard'); set('dashboard_active_at', lastActiveWrite = Date.now());
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const onText = (d) => res.write(JSON.stringify({ d }) + '\n');
    try { const reply = await (agentName === 'auto' ? auto(text, { owner: true, onText }) : runAgent(agentName, text, 0, { owner: true, onText })); res.end(JSON.stringify({ reply }) + '\n'); }
    catch (e) { res.end(JSON.stringify({ error: e.message }) + '\n'); }
    return;
  }
  let out;
  try { out = await api(req, url); }
  catch (e) { out = { error: e.message }; }
  res.writeHead(out.error ? 400 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
}).listen(PORT, HOST, () => console.log(`Sleeper Agent dashboard: http://${HOST}:${PORT}`));
