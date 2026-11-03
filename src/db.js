import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  values ('orchestrator', 'claude-opus-5-5', 'medium', 'Main assistant. Plans, remembers, delegates.', 3, 'James', 2, 1)`).run();

db.prepare(`insert or ignore into agents (name, model, effort, purpose, daily_budget_usd, max_tokens, tools, display_name, concise)
  values ('quick', 'claude-haiku-4-5', null, 'Fast, cheap answers: simple questions, quick facts, memory lookups, small edits to memory. Escalates anything complex to the orchestrator.', 1, 1024,
  'remember,recall,link_memory,set_timezone,notify_owner,list_secrets,set_reminder,list_reminders,cancel_reminder,list_projects,list_contacts,canvas_upcoming,canvas_grades', 'Pete', 2)`).run();

// Build 3 team. Names are editable in Settings; ids are what agents delegate to.
const seed = db.prepare(`insert or ignore into agents (name, model, effort, purpose, daily_budget_usd, max_tokens, tools, web, display_name) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
seed.run('researcher', 'claude-sonnet-5', 'low', 'Researches anything that needs current information: searches the web, reads pages and PDF/CSV/Excel files, and reports back a short sourced summary with links. Never takes actions.', 1, 8000, 'read_document,kalshi_markets,kalshi_backtest_data,weather_history', 1, 'Riley');
seed.run('critic', 'claude-opus-5-5', 'medium', 'Stress-tests ideas and plans: finds holes, risks, legal and platform-rule issues (checking current rules on the web when needed), weak assumptions and cheaper alternatives, then gives an improved version. Direct and specific, never just encouraging.', 1, 16000, 'recall,read_document', 1, 'Cleo');
seed.run('reader', 'claude-haiku-4-5', null, 'Reads one downloaded PDF and answers a question about it. Has no tools.', 1, 4096, '', 0, 'Reader');
seed.run('security', 'claude-haiku-4-5', null, 'Hourly security audit of the activity log. Looks for prompt injection being acted on, unexpected tool use, repeated blocked messages or wrong PINs, spending spikes, and anything off-pattern. Reports only real problems; trips the kill switch only for clear compromise.', 0.5, 2048, 'notify_owner,trip_kill_switch', 0, 'Sam');

export const get = (k) => db.prepare('select value from settings where key = ?').get(k)?.value;
export const set = (k, v) => db.prepare('insert or replace into settings values (?, ?)').run(k, String(v));
export const log = (agent, type, detail) =>
  db.prepare('insert into activity (agent, type, detail) values (?, ?, ?)')
    .run(agent, type, typeof detail === 'string' ? detail : JSON.stringify(detail));
export const agent = (name) => db.prepare('select * from agents where name = ?').get(name);
export const setStatus = (name, status) => db.prepare('update agents set status = ? where name = ?').run(status, name);
