import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.env.DB_PATH || 'data/agent.db';
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
export const db = new DatabaseSync(path);

db.exec(`
pragma journal_mode = wal;
create table if not exists settings (key text primary key, value text);
create table if not exists agents (
  name text primary key, model text not null, effort text, purpose text,
  daily_budget_usd real not null default 1, status text not null default 'idle');
create table if not exists chat (id integer primary key, ts text default current_timestamp,
  agent text, role text, content text);
create table if not exists activity (id integer primary key, ts text default current_timestamp,
  agent text, type text, detail text);
create table if not exists costs (id integer primary key, ts text default current_timestamp, day text,
  agent text, model text, input integer, output integer, cache_read integer, cache_write integer, usd real);
create table if not exists approvals (id integer primary key, ts text default current_timestamp,
  agent text, tool text, input text, reason text, status text default 'pending', decided_at text, result text);
create table if not exists memory (id integer primary key, kind text default 'note', title text not null,
  body text default '', tags text default '', pinned integer default 0,
  created_at text default current_timestamp, updated_at text default current_timestamp);
create table if not exists links (src integer, dst integer, label text, primary key (src, dst, label));
`);

const defaults = { timezone: 'America/Chicago', global_halt: '0', global_daily_budget_usd: '5' };
for (const [k, v] of Object.entries(defaults))
  db.prepare('insert or ignore into settings values (?, ?)').run(k, v);

db.prepare(`insert or ignore into agents (name, model, effort, purpose, daily_budget_usd)
  values ('orchestrator', 'claude-opus-5-5', 'medium', 'Main assistant. Plans, remembers, delegates.', 3)`).run();

export const get = (k) => db.prepare('select value from settings where key = ?').get(k)?.value;
export const set = (k, v) => db.prepare('insert or replace into settings values (?, ?)').run(k, String(v));
export const log = (agent, type, detail) =>
  db.prepare('insert into activity (agent, type, detail) values (?, ?, ?)')
    .run(agent, type, typeof detail === 'string' ? detail : JSON.stringify(detail));
export const agent = (name) => db.prepare('select * from agents where name = ?').get(name);
export const setStatus = (name, status) => db.prepare('update agents set status = ? where name = ?').run(status, name);
