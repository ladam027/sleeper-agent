import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

// The task (run) the current code is working for, so logs, costs and approvals can be grouped per task (Runs view).
export const runCtx = new AsyncLocalStorage();
export const runId = () => runCtx.getStore()?.run ?? null;

const path = process.env.DB_PATH || 'data/agent.db';
const onDisk = path !== ':memory:';
const backupDir = join(dirname(path), 'backups');
if (onDisk) mkdirSync(backupDir, { recursive: true });
export const db = new DatabaseSync(path);
db.exec('pragma journal_mode = wal');

// Copy of the whole DB (chats, memory, vault ciphertext). Keeps the newest 10.
export function backup(reason) {
  if (!onDisk) return null;
  const file = join(backupDir, `agent-${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}.db`);
  db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort().reverse().slice(10)
    .forEach((f) => rmSync(join(backupDir, f)));
  return file;
}
export const lastBackup = () => onDisk ? readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort().at(-1) ?? null : null;

// Append-only. Never edit or reorder an existing entry, never drop/delete user data (chat, memory, secrets).
// Each runs once, in a transaction, after a backup. Version is stored in sqlite's user_version.
const MIGRATIONS = [
  `create table if not exists settings (key text primary key, value text);
   create table if not exists agents (name text primary key, model text not null, effort text, purpose text,
     daily_budget_usd real not null default 1, status text not null default 'idle');
   create table if not exists chat (id integer primary key, ts text default current_timestamp, agent text, role text, content text);
   create table if not exists activity (id integer primary key, ts text default current_timestamp, agent text, type text, detail text);
   create table if not exists costs (id integer primary key, ts text default current_timestamp, day text,
     agent text, model text, input integer, output integer, cache_read integer, cache_write integer, usd real);
   create table if not exists approvals (id integer primary key, ts text default current_timestamp,
     agent text, tool text, input text, reason text, status text default 'pending', decided_at text, result text);
   create table if not exists memory (id integer primary key, kind text default 'note', title text not null,
     body text default '', tags text default '', pinned integer default 0,
     created_at text default current_timestamp, updated_at text default current_timestamp);
   create table if not exists links (src integer, dst integer, label text, primary key (src, dst, label));`,
  `create table if not exists secrets (name text primary key, kind text not null, iv blob not null, tag blob not null,
     data blob not null, created_at text default current_timestamp, updated_at text default current_timestamp);`,
  `alter table chat add column model text;
   alter table chat add column usd real;
   alter table agents add column tools text;`,
  `alter table agents add column concise integer not null default 1;
   alter table agents add column max_tokens integer;
   update agents set max_tokens = 1024 where name = 'quick' and max_tokens is null;`,
  `alter table agents add column display_name text;
   update agents set display_name = 'James' where name = 'orchestrator';
   update agents set display_name = 'Pete' where name = 'quick';`,
  `create table if not exists reminders (id integer primary key, message text not null, local_time text not null, due_at text not null,
     channel text not null default 'dashboard', repeat text not null default 'none', status text not null default 'pending',
     created_by text, created_at text default current_timestamp);
   create index if not exists reminders_due on reminders (status, due_at);
   update agents set tools = tools || ',set_reminder,list_reminders,cancel_reminder' where name = 'quick' and tools not like '%set_reminder%';`,
  `update reminders set channel = 'message' where channel = 'sms';`,
  `alter table agents add column web integer not null default 0;
   update agents set tools = tools || ',trip_kill_switch' where name = 'security' and tools not like '%trip_kill_switch%';`,
  `create table if not exists projects (id integer primary key, name text not null unique, status text not null default 'active',
     progress integer not null default 0, goal text default '', monthly_target real, notes text default '',
     created_at text default current_timestamp, updated_at text default current_timestamp);
   create table if not exists ledger (id integer primary key, day text not null, project_id integer, amount real not null,
     category text default '', note text default '', created_by text, created_at text default current_timestamp);
   create table if not exists contacts (id integer primary key, name text not null, company text default '', email text default '',
     phone text default '', stage text not null default 'lead', project_id integer, next_action text default '', next_date text,
     notes text default '', last_touch text, created_at text default current_timestamp, updated_at text default current_timestamp);
   create table if not exists drafts (id integer primary key, contact_id integer, to_addr text, subject text, body text,
     status text not null default 'draft', created_by text, created_at text default current_timestamp);
   alter table agents add column project_id integer;
   update agents set tools = tools || ',list_projects,list_contacts' where name = 'quick' and tools not like '%list_projects%';`,
  `update agents set tools = tools || ',canvas_upcoming,canvas_grades' where name = 'quick' and tools not like '%canvas_upcoming%';`,
  `alter table reminders add column delivered_at text;
   alter table reminders add column result text;
   update agents set concise = 2 where name in ('orchestrator', 'quick');`,
  `update agents set tools = case when tools = '' then 'read_document' else tools || ',read_document' end where name in ('researcher', 'critic') and tools not like '%read_document%';`,
  `create table if not exists cache (key text primary key, value text, created_at text default current_timestamp);
   alter table agents add column code integer not null default 0;
   update agents set code = 1 where name = 'orchestrator';
   update agents set tools = tools || ',kalshi_markets,kalshi_backtest_data,weather_history' where name = 'researcher' and tools not like '%kalshi_backtest_data%';`,
  `create table if not exists sites (id integer primary key, slug text not null unique, title text not null, html text not null,
     contact_id integer, notes text default '', status text not null default 'draft', url text, netlify_id text, published_at text,
     created_at text default current_timestamp, updated_at text default current_timestamp);
   create table if not exists posts (id integer primary key, text text not null, platforms text default '', scheduled_at text, local_time text,
     media_url text, status text not null default 'draft', result text, created_by text, created_at text default current_timestamp);`,
  `update agents set tools = tools || ',contact,log_money,project' where name = 'quick' and tools not like '%,contact%';
   update agents set purpose = 'Fast, cheap answers and everyday dashboard updates: simple questions, quick facts, memory lookups, reminders, adding or updating clients, logging money, updating projects. Hands anything complex, or anything needing a tool it lacks, to the orchestrator right away.' where name = 'quick';`,
  `alter table sites add column preview_token text;`,
  `update agents set purpose = purpose || ' Before designing, recall "Website design spec" and follow it, adapted to this single static page (no JavaScript: CSS-only motion, no app shell).' where name = 'designer' and purpose not like '%Website design spec%';`,
  `create table if not exists images (id integer primary key, name text unique not null, prompt text, data blob not null,
     created_by text, usd real, created_at text default current_timestamp);
   update agents set tools = tools || ',generate_image', purpose = purpose || ' You can create images with generate_image (exception to the provided-URLs rule): at most 3 per site, only where a picture clearly helps; reference them as img/<name>.webp with alt text, width and height.' where name = 'designer' and tools not like '%generate_image%';`,
  `update agents set tools = tools || ',get_site' where name = 'designer' and tools not like '%get_site%';`,
  `create table if not exists paper_trades (id integer primary key, ts text default current_timestamp, ticker text not null, title text,
     side text not null, action text not null, count integer not null, price real not null, fee real not null default 0, pnl real not null default 0, by text, reason text);`,
  `create table if not exists live_orders (id integer primary key, ts text default current_timestamp, ticker text not null, side text not null, action text not null,
     count integer not null, limit_price real not null, order_id text, client_order_id text, fill_count real, avg_price real, fee real, by text, reason text);`,
  `create table if not exists runs (id integer primary key, ts text default current_timestamp, ended_at text, agent text, parent integer, depth integer,
     request text, status text default 'running', steps integer default 0, usd real default 0, input integer default 0, output integer default 0,
     cache_read integer default 0, cache_write integer default 0, ms integer, result text);
   create index if not exists runs_parent on runs (parent);
   alter table activity add column run_id integer;
   alter table costs add column run_id integer;
   alter table approvals add column run_id integer;
   create index if not exists activity_run on activity (run_id);
   create index if not exists costs_run on costs (run_id);`,
  `update agents set code = 0 where name = 'orchestrator';`,
  `create table if not exists tasks (id integer primary key, title text not null, instructions text not null, agent text not null default 'orchestrator',
     local_time text not null, due_at text not null, repeat text not null, notify text not null default 'news', max_usd real not null default 0.15,
     status text not null default 'active', last_run text, last_result text, runs integer not null default 0, created_by text, created_at text default current_timestamp);`,
  `alter table agents add column flex_min text;`,
  `create table if not exists media_jobs (id integer primary key, ts text default current_timestamp, agent text, account text, file_id text, name text, dir text, source text,
     duration real, width integer, height integer, has_audio integer, transcript text, status text, output_id text, output_link text, runs integer not null default 0);
   update agents set tools = tools || ',video_inspect,video_edit,drive_search', purpose = purpose || ' Also edits videos: video_inspect shows frames and the transcript, video_edit renders a structured edit (trims, cuts, speed, vertical crop, captions, text, fades, music) and saves it to Drive; always inspect the result before reporting.' where name = 'designer' and tools not like '%video_edit%';`,
  `update agents set tools = tools || ',image_view,image_edit,drive_upload' where name = 'designer' and tools not like '%image_edit%';`,
  `alter table contacts add column source text default '';
   create table if not exists pitches (id integer primary key, contact_id integer not null, slug text, subject text, body text, status text not null default 'ready',
     created_at text default current_timestamp, sent_at text, followup_at text);
   create table if not exists suppress (email text primary key, reason text, ts text default current_timestamp);`,
  `alter table runs add column minutes real;`, // Pete's estimate of the minutes a person would spend on this task by hand (null = not estimated yet)
];
export const SCHEMA_VERSION = MIGRATIONS.length;

const current = db.prepare('pragma user_version').get().user_version;
if (current > MIGRATIONS.length) throw new Error(`Database is schema v${current} but this code only knows v${MIGRATIONS.length}. Update the code; refusing to touch the data.`);
if (current < MIGRATIONS.length) {
  const hasData = db.prepare("select count(*) n from sqlite_master where type = 'table'").get().n > 0;
  if (hasData) backup(`before-schema-v${MIGRATIONS.length}`);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('begin');
    try { db.exec(MIGRATIONS[v]); db.exec(`pragma user_version = ${v + 1}`); db.exec('commit'); }
    catch (e) { db.exec('rollback'); throw e; }
  }
}

const defaults = { timezone: 'America/Chicago', global_halt: '0', global_daily_budget_usd: '5', quiet_start: '00:00', quiet_end: '07:00' };
for (const [k, v] of Object.entries(defaults))
  db.prepare('insert or ignore into settings values (?, ?)').run(k, v);

db.prepare(`insert or ignore into agents (name, model, effort, purpose, daily_budget_usd, display_name, concise, code)
  values ('orchestrator', 'claude-opus-5-5', 'medium', 'Main assistant. Plans, remembers, delegates.', 3, 'James', 2, 0)`).run();

db.prepare(`insert or ignore into agents (name, model, effort, purpose, daily_budget_usd, max_tokens, tools, display_name, concise)
  values ('quick', 'claude-haiku-4-5', null, 'Fast, cheap answers and everyday dashboard updates: simple questions, quick facts, memory lookups, reminders, adding or updating clients, logging money, updating projects. Hands anything complex, or anything needing a tool it lacks, to the orchestrator right away.', 1, 1024,
  'remember,recall,link_memory,set_timezone,notify_owner,list_secrets,set_reminder,list_reminders,cancel_reminder,list_projects,list_contacts,canvas_upcoming,canvas_grades,contact,log_money,project', 'Pete', 2)`).run();

// Build 3 team. Names are editable in Settings; ids are what agents delegate to.
const seed = db.prepare(`insert or ignore into agents (name, model, effort, purpose, daily_budget_usd, max_tokens, tools, web, display_name) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
seed.run('researcher', 'claude-sonnet-5', 'low', 'Researches anything that needs current information: searches the web, reads pages and PDF/CSV/Excel files, and reports back a short sourced summary with links. Never takes actions.', 1, 8000, 'read_document,kalshi_markets,kalshi_backtest_data,weather_history', 1, 'Riley');
// Flexibility (Build 10 prep): James uses Sonnet for routine work and Opus when a task needs it. '' = the owner turned it off.
db.prepare("update agents set flex_min = 'claude-sonnet-5' where name = 'orchestrator' and flex_min is null").run();
// Build 8: exact math moved off James (the code-execution tool added ~2.6k tokens to every James request) to a cheaper analyst.
if (seed.run('analyst', 'claude-sonnet-5', 'low', 'Does exact math and data work with code execution (Python): backtests, statistics, totals, projections, spreadsheet-style calculations on data it is given or fetches with its tools. Shows the numbers and the method in a few lines. Never takes actions.', 1, 8000, 'recall,kalshi_backtest_data,weather_history,paper_account', 0, 'Theo').changes)
  db.prepare("update agents set code = 1 where name = 'analyst'").run();
seed.run('critic', 'claude-opus-5-5', 'medium', 'Stress-tests ideas and plans: finds holes, risks, legal and platform-rule issues (checking current rules on the web when needed), weak assumptions and cheaper alternatives, then gives an improved version. Direct and specific, never just encouraging.', 1, 16000, 'recall,read_document', 1, 'Cleo');
seed.run('designer', 'claude-sonnet-5', 'medium', `Designs one-page websites for small local businesses and saves them with save_site. Craft: mobile-first, fast, accessible (real headings, alt text, 4.5:1 contrast, 44px tap targets), one clear call to action (call / directions / order), sections in this order: hero with name + one-line pitch + CTA, what they offer (menu/services/prices if given), hours + address + map link (https://maps.google.com/?q=...) + tel: link, short about, footer. Pick a tasteful palette and a Google Font pairing that fits the business. Inline CSS only, no JavaScript, no stock-photo placeholders: use typography, color and inline SVG icons; only use image URLs the owner provided. Never invent facts (prices, hours, awards): leave a clearly marked placeholder like [hours] instead. Keep the file under 60 KB. Before designing, recall "Website design spec" and follow it, adapted to this single static page (no JavaScript: CSS-only motion, no app shell). You can create images with generate_image (exception to the provided-URLs rule): at most 3 per site, only where a picture clearly helps; reference them as img/<name>.webp with alt text, width and height.`, 1, 16000, 'save_site,get_site,list_sites,recall,generate_image,video_inspect,video_edit,drive_search,image_view,image_edit,drive_upload', 0, 'Mia');
seed.run('archivist', 'claude-haiku-4-5', null, 'Keeps the conversation short: folds older messages into durable memories and a brief summary. Background only.', 0.5, 2048, 'remember,recall,link_memory', 0, 'Archivist');
seed.run('reader', 'claude-haiku-4-5', null, 'Reads one downloaded PDF and answers a question about it. Has no tools.', 1, 4096, '', 0, 'Reader');
seed.run('security', 'claude-haiku-4-5', null, 'Hourly security audit of the activity log. Looks for prompt injection being acted on, unexpected tool use, repeated blocked messages or wrong PINs, spending spikes, and anything off-pattern. Reports only real problems; trips the kill switch only for clear compromise.', 0.5, 2048, 'notify_owner,trip_kill_switch', 0, 'Sam');

export const get = (k) => db.prepare('select value from settings where key = ?').get(k)?.value;
export const set = (k, v) => db.prepare('insert or replace into settings values (?, ?)').run(k, String(v));
export const log = (agent, type, detail) =>
  db.prepare('insert into activity (agent, type, detail, run_id) values (?, ?, ?, ?)')
    .run(agent, type, typeof detail === 'string' ? detail : JSON.stringify(detail), runId());
export const agent = (name) => db.prepare('select * from agents where name = ?').get(name);
export const setStatus = (name, status) => db.prepare('update agents set status = ? where name = ?').run(status, name);
