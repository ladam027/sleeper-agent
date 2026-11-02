// Updates must never lose chats: migrations run on old databases, keep data, and back up first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('old (pre-migration) database keeps its chats and gets backed up before upgrading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleeper-'));
  process.env.DB_PATH = join(dir, 'agent.db');
  // Simulate the v1.0 database: tables exist, user_version 0, one chat.
  const old = new DatabaseSync(process.env.DB_PATH);
  old.exec("create table chat (id integer primary key, ts text default current_timestamp, agent text, role text, content text); insert into chat (agent, role, content) values ('orchestrator', 'user', 'remember me')");
  old.close();

  const { db, SCHEMA_VERSION, backup } = await import('../src/db.js?first');
  assert.equal(db.prepare('pragma user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(db.prepare('select content from chat').get().content, 'remember me');
  assert.equal(readdirSync(join(dir, 'backups')).length, 1, 'backup taken before migrating');

  // A second start (simulating an update/restart) changes nothing.
  db.close();
  const again = await import('../src/db.js?second');
  assert.equal(again.db.prepare('select count(*) n from chat').get().n, 1);
  assert.ok(again.backup('manual').endsWith('-manual.db'));
});

test('refuses to open a database from a newer version instead of damaging it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleeper-'));
  process.env.DB_PATH = join(dir, 'agent.db');
  const future = new DatabaseSync(process.env.DB_PATH);
  future.exec('pragma user_version = 999');
  future.close();
  await assert.rejects(import('../src/db.js?future'), /refusing to touch the data/);
});
