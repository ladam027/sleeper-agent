// Build 4 part 1: projects, ledger, cost vs ROI, CRM, drafts.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, set } = await import('../src/db.js');
const money = await import('../src/money.js');
const { recordUsd, today } = await import('../src/budget.js');
const { TOOLS } = await import('../src/tools.js');

test('projects: create, update with bounds, reject bad status', () => {
  assert.match(money.upsertProject({ name: 'Etsy prints', monthly_target: 300, goal: '50 sales/month' }), /Created project #1/);
  money.upsertProject({ id: 1, progress: 140 });
  assert.equal(db.prepare('select progress from projects where id = 1').get().progress, 100);
  assert.throws(() => money.upsertProject({ name: 'x', status: 'vibes' }), /status/);
  assert.equal(money.projectId('etsy PRINTS'), 1);
  assert.equal(money.projectId('1'), 1, 'numeric strings from the dashboard work');
  assert.throws(() => money.projectId('nope'), /No project/);
});

test('ROI counts ledger plus the AI spend of agents assigned to the project', () => {
  money.logMoney({ amount: 120, project: 'Etsy prints', category: 'sales' });
  money.logMoney({ amount: -20, project: 1, category: 'ads' });
  money.logMoney({ amount: 50, note: 'tutoring' }); // no project
  db.exec("insert into agents (name, model, purpose, project_id) values ('etsy-bot', 'claude-haiku-4-5', 'x', 1)");
  recordUsd('etsy-bot', 'claude-haiku-4-5', 5);
  recordUsd('orchestrator', 'claude-opus-5-5', 3); // overhead, not the project's
  const s = money.moneySummary();
  const p = s.projects[0];
  assert.deepEqual([p.month.income, p.month.expenses, p.month.api, p.month.net], [120, 20, 5, 95]);
  assert.equal(p.all.roi, 95 / 25);
  assert.deepEqual([s.totals.income, s.totals.expenses, s.totals.aiAndPhone, s.totals.net], [170, 20, 8, 142]);
  assert.equal(s.goal, 1000);
  set('monthly_income_goal', 1500);
  assert.equal(money.moneySummary().goal, 1500);
  assert.throws(() => money.logMoney({ amount: 0 }), /non-zero/);
  assert.throws(() => money.logMoney({ amount: 5, day: 'yesterday' }), /YYYY-MM-DD/);
});

test('CRM: stages, follow-up ordering, last touch on stage change', () => {
  money.upsertContact({ name: 'Dana', company: 'Local Bakery', email: 'dana@example.com', next_date: '2026-11-20', project: 'Etsy prints' });
  money.upsertContact({ name: 'Sam', next_date: '2026-11-05' });
  assert.deepEqual(money.listContacts().map((c) => c.name), ['Sam', 'Dana'], 'soonest follow-up first');
  money.upsertContact({ id: 1, stage: 'contacted' });
  assert.ok(db.prepare('select last_touch from contacts where id = 1').get().last_touch);
  assert.equal(money.listContacts({ stage: 'contacted' })[0].name, 'Dana');
  assert.throws(() => money.upsertContact({ name: 'X', stage: 'bff' }), /stage/);
});

test('drafts are saved, never sent, and agents can write them', async () => {
  assert.match(await TOOLS.draft_email.run({ contact_id: 1, subject: 'Prints for your bakery', body: 'Hi Dana…' }, { agent: 'orchestrator' }), /Saved draft #1/);
  const d = money.listDrafts()[0];
  assert.equal(d.to_addr, 'dana@example.com');
  assert.equal(d.status, 'draft');
  assert.throws(() => money.saveDraft({ subject: '', body: 'x' }), /subject/);
});

test('list_projects tool gives the agents the money picture', () => {
  const out = JSON.parse(TOOLS.list_projects.run({}));
  assert.equal(out.projects[0].name, 'Etsy prints');
  assert.ok('net' in out.totals);
});
