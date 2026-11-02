// Money cockpit: projects, a simple ledger, cost vs ROI, and a lightweight CRM with email drafts.
// Amounts are USD. Ledger: positive = income, negative = expense. API/phone spend comes from the costs table.
import { db, get, log } from './db.js';
import { today } from './budget.js';

const STATUSES = ['idea', 'active', 'paused', 'done', 'dropped'];
export const STAGES = ['lead', 'contacted', 'replied', 'meeting', 'client', 'lost'];
const month = () => today().slice(0, 7);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

export function projectId(ref) {
  if (ref == null || ref === '') return null;
  if (/^\d+$/.test(String(ref))) ref = Number(ref);
  const p = Number.isInteger(ref) ? db.prepare('select id from projects where id = ?').get(ref)
    : db.prepare('select id from projects where lower(name) = lower(?)').get(String(ref));
  if (!p) throw new Error(`No project "${ref}". Create it first with the project tool.`);
  return p.id;
}

export function upsertProject({ id, name, status, progress, goal, monthly_target, notes }) {
  if (id) {
    const cur = db.prepare('select * from projects where id = ?').get(id);
    if (!cur) throw new Error(`No project #${id}`);
    if (status && !STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    db.prepare(`update projects set name = ?, status = ?, progress = ?, goal = ?, monthly_target = ?, notes = ?, updated_at = current_timestamp where id = ?`)
      .run(name ?? cur.name, status ?? cur.status, progress == null ? cur.progress : clamp(progress, 0, 100), goal ?? cur.goal,
        monthly_target === undefined ? cur.monthly_target : monthly_target, notes ?? cur.notes, id);
    log('owner', 'project', `#${id} ${name ?? cur.name} updated`);
    return `Updated project #${id}`;
  }
  if (!name?.trim()) throw new Error('A new project needs a name');
  if (status && !STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const r = db.prepare('insert into projects (name, status, progress, goal, monthly_target, notes) values (?, ?, ?, ?, ?, ?)')
    .run(name.trim().slice(0, 80), status || 'active', clamp(progress, 0, 100), goal || '', monthly_target ?? null, notes || '');
  log('owner', 'project', `#${r.lastInsertRowid} ${name} created`);
  return `Created project #${r.lastInsertRowid} ${name}`;
}

export function logMoney({ amount, project, category = '', note = '', day }, by = 'owner') {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!amt) throw new Error('amount must be a non-zero number (positive = income, negative = expense)');
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');
  const r = db.prepare('insert into ledger (day, project_id, amount, category, note, created_by) values (?, ?, ?, ?, ?, ?)')
    .run(day || today(), projectId(project), amt, String(category).slice(0, 40), String(note).slice(0, 300), by);
  log(by, 'money', `${amt > 0 ? 'income' : 'expense'} $${Math.abs(amt).toFixed(2)}${note ? ` (${note.slice(0, 60)})` : ''}`);
  return `Logged ${amt > 0 ? 'income' : 'expense'} #${r.lastInsertRowid}: $${Math.abs(amt).toFixed(2)}`;
}

// Per-project and overall money picture. API/phone spend of agents assigned to a project counts against it;
// everything else is overhead.
export function moneySummary() {
  const m = month();
  const ledger = (where, ...a) => db.prepare(`select coalesce(sum(case when amount > 0 then amount end), 0) income,
    coalesce(-sum(case when amount < 0 then amount end), 0) expenses from ledger where ${where}`).get(...a);
  const apiFor = (pid, monthOnly) => db.prepare(`select coalesce(sum(c.usd), 0) s from costs c join agents a on a.name = c.agent
    where a.project_id = ? ${monthOnly ? 'and substr(c.day, 1, 7) = ?' : ''}`).get(...(monthOnly ? [pid, m] : [pid])).s;
  const projects = db.prepare("select * from projects order by case status when 'active' then 0 when 'idea' then 1 when 'paused' then 2 else 3 end, updated_at desc").all().map((p) => {
    const mo = ledger('project_id = ? and substr(day, 1, 7) = ?', p.id, m), all = ledger('project_id = ?', p.id);
    const apiMonth = apiFor(p.id, true), apiAll = apiFor(p.id, false);
    const costAll = all.expenses + apiAll;
    return { ...p, month: { ...mo, api: apiMonth, net: mo.income - mo.expenses - apiMonth },
      all: { ...all, api: apiAll, net: all.income - costAll, roi: costAll ? (all.income - costAll) / costAll : null } };
  });
  const mo = ledger('substr(day, 1, 7) = ?', m);
  const spend = db.prepare('select coalesce(sum(usd), 0) s from costs where substr(day, 1, 7) = ?').get(m).s;
  const goal = Number(get('monthly_income_goal') || 1000);
  const months = db.prepare(`select substr(day, 1, 7) m, coalesce(sum(case when amount > 0 then amount end), 0) income,
    coalesce(-sum(case when amount < 0 then amount end), 0) expenses from ledger group by m order by m desc limit 6`).all().reverse();
  const spendBy = Object.fromEntries(db.prepare('select substr(day, 1, 7) m, sum(usd) s from costs group by m').all().map((r) => [r.m, r.s]));
  return {
    month: m, goal,
    totals: { income: mo.income, expenses: mo.expenses, aiAndPhone: spend, net: mo.income - mo.expenses - spend },
    months: months.map((x) => ({ ...x, aiAndPhone: spendBy[x.m] || 0 })),
    projects,
    recent: db.prepare('select l.*, p.name project from ledger l left join projects p on p.id = l.project_id order by l.day desc, l.id desc limit 25').all(),
  };
}

export function upsertContact({ id, name, company, email, phone, stage, project, next_action, next_date, notes }) {
  if (stage && !STAGES.includes(stage)) throw new Error(`stage must be one of ${STAGES.join(', ')}`);
  if (next_date && !/^\d{4}-\d{2}-\d{2}$/.test(next_date)) throw new Error('next_date must be YYYY-MM-DD');
  if (id) {
    const c = db.prepare('select * from contacts where id = ?').get(id);
    if (!c) throw new Error(`No contact #${id}`);
    const touched = stage && stage !== c.stage;
    db.prepare(`update contacts set name = ?, company = ?, email = ?, phone = ?, stage = ?, project_id = ?, next_action = ?, next_date = ?, notes = ?,
      last_touch = case when ? then current_timestamp else last_touch end, updated_at = current_timestamp where id = ?`)
      .run(name ?? c.name, company ?? c.company, email ?? c.email, phone ?? c.phone, stage ?? c.stage,
        project === undefined ? c.project_id : projectId(project), next_action ?? c.next_action, next_date === undefined ? c.next_date : next_date,
        notes ?? c.notes, touched ? 1 : 0, id);
    if (touched) log('owner', 'crm', `${c.name}: ${c.stage} → ${stage}`);
    return `Updated contact #${id}`;
  }
  if (!name?.trim()) throw new Error('A new contact needs a name');
  const r = db.prepare(`insert into contacts (name, company, email, phone, stage, project_id, next_action, next_date, notes)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name.trim(), company || '', email || '', phone || '', stage || 'lead', projectId(project),
    next_action || '', next_date || null, notes || '');
  log('owner', 'crm', `added ${name}${company ? ` (${company})` : ''}`);
  return `Added contact #${r.lastInsertRowid} ${name}`;
}

export const listContacts = ({ stage, project } = {}) => db.prepare(`select c.*, p.name project from contacts c left join projects p on p.id = c.project_id
  where (? is null or c.stage = ?) and (? is null or c.project_id = ?)
  order by case c.stage when 'client' then 3 when 'lost' then 4 else 0 end, coalesce(c.next_date, '9999'), c.updated_at desc`)
  .all(stage ?? null, stage ?? null, project == null ? null : projectId(project), project == null ? null : projectId(project));

// Drafts only: sending needs the owner (and Gmail, Build 4 part 2).
export function saveDraft({ contact_id, to, subject, body }, by = 'owner') {
  if (!subject?.trim() || !body?.trim()) throw new Error('A draft needs a subject and body');
  const c = contact_id ? db.prepare('select * from contacts where id = ?').get(contact_id) : null;
  if (contact_id && !c) throw new Error(`No contact #${contact_id}`);
  const r = db.prepare('insert into drafts (contact_id, to_addr, subject, body, created_by) values (?, ?, ?, ?, ?)')
    .run(c?.id ?? null, to || c?.email || '', subject.slice(0, 200), body.slice(0, 8000), by);
  log(by, 'draft', `email draft #${r.lastInsertRowid} to ${to || c?.name || '(no recipient)'}: ${subject.slice(0, 80)}`);
  return `Saved draft #${r.lastInsertRowid}. The owner reviews and sends it.`;
}
export const listDrafts = () => db.prepare("select d.*, c.name contact from drafts d left join contacts c on c.id = d.contact_id where d.status = 'draft' order by d.id desc limit 50").all();
