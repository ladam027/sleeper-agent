import { db, set, log } from './db.js';
import { PRICES } from './budget.js';
import { names as secretNames } from './vault.js';

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

  recall: tool('recall', 'Search long-term memory. Use before answering anything about the owner, their projects, or past decisions.',
    { query: str('keywords') }, ['query'],
    ({ query }) => {
      // ponytail: LIKE scan per word; switch to FTS5/embeddings when memory passes a few thousand rows.
      const words = query.split(/\s+/).filter(Boolean).slice(0, 6);
      if (!words.length) return '[]';
      const where = words.map(() => "(title || ' ' || body || ' ' || tags) like ?").join(' or ');
      const rows = db.prepare(`select id, kind, title, body, tags from memory where ${where} order by updated_at desc limit 10`)
        .all(...words.map((w) => `%${w}%`));
      return JSON.stringify(rows);
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
      return `Timezone set to ${timezone}`;
    }),

  notify_owner: tool('notify_owner', 'Send the owner an update. urgency: low (dashboard only), high (text, Build 2), critical (phone call, Build 2).',
    { message: str('what to tell them'), urgency: { type: 'string', enum: ['low', 'high', 'critical'] } }, ['message', 'urgency'],
    ({ message, urgency }, ctx) => {
      log(ctx.agent, `notify:${urgency}`, message); // Build 2 routes high/critical to Twilio SMS/call
      return 'Delivered to dashboard';
    }),

  list_secrets: tool('list_secrets', "List the names and kinds of the owner's vault entries (passwords, cards, personal info). You never get the values; reference one as {{secret:name}}.",
    {}, [], () => JSON.stringify(secretNames())),

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
