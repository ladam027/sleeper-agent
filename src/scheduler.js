// Reminders/alarms and nightly jobs. One 30-second tick, no cron, no extra process.
import { db, get, set, log, backup } from './db.js';
import { notify } from './phone.js';

// Wall-clock parts of an instant in a timezone.
function parts(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: p.weekday };
}
const offset = (t, tz) => { const p = parts(new Date(t), tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000; };

// "2026-11-03T06:30" in tz → Date. Two passes so times next to a DST switch land correctly.
export function localToUtc(local, tz) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)$/.exec(local || '');
  if (!m) throw new Error('Time must look like 2026-11-03T06:30 (owner local time)');
  const guess = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  const first = guess - offset(guess, tz);
  return new Date(guess - offset(first, tz));
}
export const localNow = (tz) => { const p = parts(new Date(), tz); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`; };

// Next occurrence keeps the same wall-clock time (6:30 stays 6:30 across DST and timezone moves).
export function nextLocal(local, repeat) {
  const [date, time] = local.split('T');
  const d = new Date(date + 'T00:00:00Z');
  do d.setUTCDate(d.getUTCDate() + (repeat === 'weekly' ? 7 : 1));
  while (repeat === 'weekdays' && [0, 6].includes(d.getUTCDay()));
  return `${d.toISOString().slice(0, 10)}T${time}`;
}

const pretty = (date, tz) => date.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export function addReminder({ message, when, channel = 'dashboard', repeat = 'none' }, agent = 'owner') {
  const tz = get('timezone'), due = localToUtc(when, tz);
  if (!message?.trim()) throw new Error('Reminder needs a message');
  if (!['dashboard', 'sms', 'call'].includes(channel)) throw new Error('channel must be dashboard, sms or call');
  if (!['none', 'daily', 'weekdays', 'weekly'].includes(repeat)) throw new Error('repeat must be none, daily, weekdays or weekly');
  if (due < Date.now() - 60e3) throw new Error(`That time (${pretty(due, tz)}) is in the past`);
  const { lastInsertRowid: id } = db.prepare('insert into reminders (message, local_time, due_at, channel, repeat, created_by) values (?, ?, ?, ?, ?, ?)')
    .run(message.trim().slice(0, 500), when, due.toISOString(), channel, repeat, agent);
  log(agent, 'reminder', `#${id} ${pretty(due, tz)} via ${channel}${repeat !== 'none' ? ` (${repeat})` : ''}: ${message.slice(0, 120)}`);
  return `Reminder #${id} set for ${pretty(due, tz)} via ${channel}${repeat !== 'none' ? `, repeating ${repeat}` : ''}`;
}
export const upcoming = () => db.prepare("select * from reminders where status = 'pending' order by due_at limit 50").all();
export function cancelReminder(id) {
  const r = db.prepare("update reminders set status = 'cancelled' where id = ? and status = 'pending'").run(id);
  if (!r.changes) return `No pending reminder #${id}`;
  log('owner', 'reminder', `#${id} cancelled`);
  return `Cancelled reminder #${id}`;
}

// After a timezone change, pending reminders keep their wall-clock time in the new zone.
export function rezone() {
  const tz = get('timezone');
  for (const r of upcoming()) db.prepare('update reminders set due_at = ? where id = ?').run(localToUtc(r.local_time, tz).toISOString(), r.id);
}

let ticking = false;
export async function tick(now = new Date()) {
  if (ticking) return; // a slow phone call must not double-fire
  ticking = true;
  try {
    const tz = get('timezone');
    for (const r of db.prepare("select * from reminders where status = 'pending' and due_at <= ?").all(now.toISOString())) {
      const late = now - new Date(r.due_at) > 10 * 60e3 ? ' (late: the server was off)' : '';
      const urgency = { dashboard: 'low', sms: 'high', call: 'critical' }[r.channel];
      await notify(urgency, `Reminder: ${r.message}${late}`, { agent: 'scheduler', alarm: r.channel === 'call' });
      if (r.repeat === 'none') db.prepare("update reminders set status = 'done' where id = ?").run(r.id);
      else {
        let next = nextLocal(r.local_time, r.repeat);
        while (localToUtc(next, tz) <= now) next = nextLocal(next, r.repeat); // skip occurrences missed while off
        db.prepare('update reminders set local_time = ?, due_at = ? where id = ?').run(next, localToUtc(next, tz).toISOString(), r.id);
      }
    }
    // Nightly backup at 03:00 owner time.
    const today = localNow(tz).slice(0, 10);
    if (localNow(tz).slice(11) >= '03:00' && get('last_nightly_backup') !== today) { backup('nightly'); set('last_nightly_backup', today); }
  } catch (e) { log('scheduler', 'error', e.message); }
  finally { ticking = false; }
}
export const start = () => { tick(); return setInterval(tick, 30e3); };
