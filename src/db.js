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

const defaults = { timezone: 'America/Chicago', global_halt: '0', global_daily_budget_usd: '5' };
for (const [k, v] of Object.entries(defaults))
  db.prepare('insert or ignore into settings values (?, ?)').run(k, v);

db.prepare(`insert or ignore into agents (name, model, effort, purpose, daily_budget_usd)
  values ('orchestrator', 'claude-opus-5-5', 'medium', 'Main assistant. Plans, remembers, delegates.', 3)`).run();

db.prepare(`insert or ignore into agents (name, model, effort, purpose, daily_budget_usd, max_tokens, tools)
  values ('quick', 'claude-haiku-4-5', null, 'Fast, cheap answers: simple questions, quick facts, memory lookups, small edits to memory. Escalates anything complex to the orchestrator.', 1, 1024,
  'remember,recall,link_memory,set_timezone,notify_owner,list_secrets')`).run();

export const get = (k) => db.prepare('select value from settings where key = ?').get(k)?.value;
export const set = (k, v) => db.prepare('insert or replace into settings values (?, ?)').run(k, String(v));
export const log = (agent, type, detail) =>
  db.prepare('insert into activity (agent, type, detail) values (?, ?, ?)')
    .run(agent, type, typeof detail === 'string' ? detail : JSON.stringify(detail));
export const agent = (name) => db.prepare('select * from agents where name = ?').get(name);
export const setStatus = (name, status) => db.prepare('update agents set status = ? where name = ?').run(status, name);
