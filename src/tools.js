import { db, set, log } from './db.js';
import { PRICES } from './budget.js';
import { names as secretNames } from './vault.js';
import { notify } from './phone.js';
import { addReminder, upcoming, cancelReminder, rezone } from './scheduler.js';

// risk 'high' = never runs directly; the agent loop queues it for owner approval instead.
// Gating lives in code (agent.js), not in the prompt, so prompt injection can't talk past it.
const tool = (name, description, properties, required, run, risk = 'low') =>
  ({ risk, run, def: { name, description, input_schema: { type: 'object', properties, required } } });

const str = (description) => ({ type: 'string', description });

export const TOOLS = {
  remember: tool('remember', 'Save or update a long-term memory about the owner, a project, a person, or a decision. Pass id to update. pinned=true puts it in every prompt (use for core facts only).',
    { title: str('short title'), body: str('the fact, in full'), kind: str('person | project | preference | fact | decision | note'),
      tags: str('comma-separated'), pinned: { type: 'boolean' }, id: { type: 'integer' } }, ['title', 'body'],
    ({ id, title, body, kind = 'note', tags = '', pinned = false }) => {
      if (id) {
        db.prepare(`update memory set title=?, body=?, kind=?, tags=?, pinned=?, updated_at=current_timestamp where id=?`)
          .run(title, body, kind, tags, pinned ? 1 : 0, id);
        return `Updated memory #${id}`;
      }
      const r = db.prepare('insert into memory (title, body, kind, tags, pinned) values (?, ?, ?, ?, ?)')
        .run(title, body, kind, tags, pinned ? 1 : 0);
      return `Saved memory #${r.lastInsertRowid}`;
    }),

  recall: tool('recall', 'Search long-term memory. Use before answering anything about the owner, their projects, or past decisions. Leave query empty to list everything saved.',
    { query: str('keywords, or empty for everything') }, [],
    ({ query = '' }) => {
      // ponytail: LIKE scan per word; switch to FTS5/embeddings when memory passes a few thousand rows.
      const cols = 'id, kind, title, body, tags, pinned';
      const words = query.split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
      const where = words.map(() => "(title || ' ' || body || ' ' || tags || ' ' || kind) like ?").join(' or ');
      const hits = words.length ? db.prepare(`select ${cols} from memory where ${where} order by pinned desc, updated_at desc limit 15`)
        .all(...words.map((w) => `%${w}%`)) : [];
      if (hits.length) return JSON.stringify(hits);
      // Keyword search misses synonyms ("owner" vs "user"), so never report empty while memories exist.
      const total = db.prepare('select count(*) n from memory').get().n;
      const recent = db.prepare(`select ${cols} from memory order by pinned desc, updated_at desc limit 30`).all();
      return JSON.stringify({ note: total ? `${words.length ? 'No keyword match. ' : ''}Showing ${recent.length} of ${total} memories, most important first.` : 'Memory is empty.', memories: recent });
    }),

  link_memory: tool('link_memory', 'Connect two memories (e.g. person -> works_on -> project). Builds the memory graph.',
    { src: { type: 'integer' }, dst: { type: 'integer' }, label: str('relationship, e.g. works_on, depends_on, owns') },
    ['src', 'dst', 'label'],
    ({ src, dst, label }) => {
      db.prepare('insert or ignore into links values (?, ?, ?)').run(src, dst, label);
      return `Linked #${src} -${label}-> #${dst}`;
    }),

  set_timezone: tool('set_timezone', "Change the owner's current timezone, e.g. when they say they've travelled. IANA name like America/Denver.",
    { timezone: str('IANA timezone') }, ['timezone'],
    ({ timezone }) => {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }); // throws RangeError on bad names
      set('timezone', timezone);
      rezone();
      return `Timezone set to ${timezone}`;
    }),

  notify_owner: tool('notify_owner', 'Tell the owner something now. urgency: low = dashboard only; high = text message; critical = phone call + text (only for urgent, important things; calls become texts during quiet hours). Keep it short.',
    { message: str('what to tell them, under 300 characters'), urgency: { type: 'string', enum: ['low', 'high', 'critical'] } }, ['message', 'urgency'],
    ({ message, urgency }, ctx) => notify(urgency, message, { agent: ctx.agent })),

  set_reminder: tool('set_reminder', "Schedule a reminder or alarm for the owner. 'when' is the owner's local time as YYYY-MM-DDTHH:MM (use the [Now: ...] line to resolve 'tomorrow', 'in 2 hours'). channel: dashboard, sms (text), or call (an alarm; rings even in quiet hours because the owner asked for it). repeat: none, daily, weekdays, weekly.",
    { message: str('what to remind them'), when: str('YYYY-MM-DDTHH:MM owner local time'), channel: { type: 'string', enum: ['dashboard', 'sms', 'call'] },
      repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly'] } }, ['message', 'when'],
    (input, ctx) => addReminder(input, ctx.agent)),

  list_reminders: tool('list_reminders', "List the owner's upcoming reminders and alarms.", {}, [],
    () => JSON.stringify(upcoming().map(({ id, message, local_time, channel, repeat }) => ({ id, message, local_time, channel, repeat })))),

  cancel_reminder: tool('cancel_reminder', 'Cancel an upcoming reminder by id (use list_reminders first).', { id: { type: 'integer' } }, ['id'],
    ({ id }) => cancelReminder(id)),

  list_secrets: tool('list_secrets', "List the names and kinds of the owner's vault entries (passwords, cards, personal info). You never get the values; reference one as {{secret:name}}.",
    {}, [], () => JSON.stringify(secretNames())),

  escalate: tool('escalate', 'Hand this request to the more capable orchestrator model. Call it immediately, without answering, when the request needs planning, research, analysis, writing, multi-step work, careful judgment, or a tool you lack. Do not use it for simple questions, quick facts, or memory lookups.',
    { reason: str('one short phrase') }, ['reason'],
    ({ reason }, ctx) => { ctx.escalated = reason; return 'Handing off to the orchestrator.'; }),

  delegate: tool('delegate', 'Hand a self-contained task to a sub-agent and get its answer. The sub-agent has no access to this conversation, so include all context.',
    { agent: str('sub-agent name'), task: str('full task description') }, ['agent', 'task'],
    async ({ agent, task }, ctx) => {
      if (ctx.depth >= 2) return 'Refused: delegation depth limit reached';
      if (agent === ctx.agent) return 'Refused: an agent cannot delegate to itself';
      return ctx.run(agent, task, ctx.depth + 1);
    }),

  create_agent: tool('create_agent', 'Create a new sub-agent for a project. Requires owner approval. Prefer claude-haiku-4-5 or claude-sonnet-5 for workers.',
    { name: str('lowercase-slug'), model: { type: 'string', enum: Object.keys(PRICES) }, purpose: str('what it does'),
      daily_budget_usd: { type: 'number' }, effort: { type: 'string', enum: ['low', 'medium', 'high'] } },
    ['name', 'model', 'purpose', 'daily_budget_usd'],
    ({ name, model, purpose, daily_budget_usd, effort = 'low' }) => {
      if (!/^[a-z0-9-]{2,32}$/.test(name)) return 'Refused: name must be a lowercase slug';
      if (!PRICES[model]) return `Refused: unknown model ${model}`;
      db.prepare('insert into agents (name, model, effort, purpose, daily_budget_usd) values (?, ?, ?, ?, ?)')
        .run(name, model, effort, purpose, Math.min(daily_budget_usd, 5));
      return `Created agent ${name}`;
    }, 'high'),
};
