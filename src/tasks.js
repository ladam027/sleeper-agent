// Build 9: scheduled and watching tasks ("every morning…", "watch X and text me when Y"). Real runs on a timer,
// each with a per-run budget, a fresh context (instructions + last report) and a quiet "NOTHING NEW" path.
import { db, get, log } from './db.js';
import { localToUtc, localNow, nextLocal } from './scheduler.js';
import { redact } from './vault.js';

export const deps = { run: null, notify: null }; // set in start() (avoids an import cycle with agent.js); tests swap them
export const REPEATS = ['once', 'hourly', 'every-3-hours', 'daily', 'weekdays', 'weekly'];
export const LIMITS = { active: 12, max_usd: 1, default_usd: 0.15 };
const QUIET = /^\s*NOTHING NEW\b/i;

function next(local, repeat) {
  if (repeat === 'hourly' || repeat === 'every-3-hours') {
    const d = new Date(local.replace('T', ' ') + 'Z'); d.setUTCHours(d.getUTCHours() + (repeat === 'hourly' ? 1 : 3));
    return d.toISOString().slice(0, 16);
  }
  return nextLocal(local, repeat);
}

export function schedule({ title, instructions, when, repeat = 'daily', notify = 'news', max_usd = LIMITS.default_usd, agent = 'orchestrator' }, by = 'orchestrator') {
  if (!title?.trim() || !instructions?.trim()) throw new Error('A task needs a title and instructions');
  if (!REPEATS.includes(repeat)) throw new Error(`repeat must be one of ${REPEATS.join(', ')}`);
  if (!['news', 'always'].includes(notify)) throw new Error('notify must be news (only when there is something new) or always');
  if (!(max_usd > 0 && max_usd <= LIMITS.max_usd)) throw new Error(`max_usd must be between $0.01 and $${LIMITS.max_usd} per run`);
  const active = db.prepare("select count(*) n from tasks where status = 'active'").get().n;
  if (active >= LIMITS.active) throw new Error(`At most ${LIMITS.active} active tasks; cancel one first`);
  const tz = get('timezone'), local = when || localNow(tz), due = localToUtc(local, tz);
  const { lastInsertRowid: id } = db.prepare('insert into tasks (title, instructions, agent, local_time, due_at, repeat, notify, max_usd, created_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(title.trim().slice(0, 100), instructions.trim().slice(0, 2000), agent, local, due.toISOString(), repeat, notify, max_usd, by);
  log(by, 'task', `scheduled #${id} "${title.slice(0, 60)}" ${repeat} from ${local} (≤$${max_usd}/run)`);
  return `Scheduled task #${id} "${title}": ${repeat === 'once' ? 'once' : repeat} starting ${local} (owner time), up to $${max_usd} a run, ${notify === 'always' ? 'reports every run' : 'messages the owner only when there is something new'}.`;
}

export const list = () => db.prepare("select id, title, instructions, repeat, local_time, due_at, notify, max_usd, status, last_run, last_result, runs from tasks where status != 'deleted' order by status, due_at").all();
export function setStatus(id, status) {
  if (!['active', 'paused', 'deleted'].includes(status)) throw new Error('status must be active, paused or deleted');
  const t = db.prepare('select * from tasks where id = ?').get(id);
  if (!t) throw new Error(`No task #${id}`);
  db.prepare('update tasks set status = ? where id = ?').run(status, id);
  log('owner', 'task', `task #${id} ${status}`);
  return `Task #${id} "${t.title}" ${status === 'deleted' ? 'cancelled' : status}.`;
}

// Runs due tasks one at a time. A busy agent just means "try again next minute".
let ticking = false;
export async function tick(now = new Date()) {
  if (ticking) return; ticking = true;
  try {
    for (const t of db.prepare("select * from tasks where status = 'active' and due_at <= ? order by due_at").all(now.toISOString())) {
      const prompt = `Scheduled task #${t.id} "${t.title}" (${t.repeat}). Do this now:\n${t.instructions}\n\nYour last report: ${t.last_result || '(first run)'}\n\nFinish with a short report for the owner (1-3 sentences, what changed). If nothing is new or worth their attention compared with your last report, reply with exactly NOTHING NEW.`;
      const r = await deps.run(t.agent, prompt, 0, { ephemeral: true, maxUsd: t.max_usd });
      const reply = redact(String(typeof r === 'string' ? r : r?.reply || ''));
      if (/is busy with another task/.test(reply)) continue;
      const tz = get('timezone');
      let nextLocalTime = t.repeat === 'once' ? null : next(t.local_time, t.repeat);
      while (nextLocalTime && localToUtc(nextLocalTime, tz) <= now) nextLocalTime = next(nextLocalTime, t.repeat); // skip runs missed while off
      db.prepare("update tasks set last_run = current_timestamp, runs = runs + 1, last_result = case when ? then last_result else ? end, local_time = coalesce(?, local_time), due_at = coalesce(?, due_at), status = case when ? then 'done' else status end where id = ?")
        .run(QUIET.test(reply) ? 1 : 0, reply.slice(0, 1000), nextLocalTime, nextLocalTime && localToUtc(nextLocalTime, tz).toISOString(), t.repeat === 'once' ? 1 : 0, t.id);
      log(t.agent, 'task', `ran #${t.id} "${t.title}": ${reply.slice(0, 160)}`);
      if (!QUIET.test(reply) || t.notify === 'always') {
        db.prepare("insert into chat (agent, role, content, model) values ('orchestrator', 'assistant', ?, null)").run(`[Scheduled: ${t.title}] ${reply}`);
        await deps.notify?.('high', `${t.title}: ${reply}`.slice(0, 900), { agent: t.agent }).catch(() => {});
      }
    }
  } finally { ticking = false; }
}
export function start(run, notify) { deps.run = run; deps.notify = notify; return setInterval(() => tick().catch((e) => log('owner', 'error', `tasks: ${e.message}`)), 60e3); }
