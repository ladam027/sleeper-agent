import { db, get, agent } from './db.js';

// $ per million tokens. cacheWrite = 5-minute cache write (1.25x input).
export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export const MAX_STEPS = 8; // model calls per run; stops runaway tool loops

export const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches; web fetch has no per-use fee

// batch = Message Batches API (50% off tokens).
export function costOf(model, u, { batch = false } = {}) {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for ${model}; add it to PRICES before using it`);
  const tokens = ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output +
    (u.cache_read_input_tokens || 0) * p.cacheRead + (u.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
  return tokens * (batch ? 0.5 : 1) + (u.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_USD;
}

// Calendar day in the owner's timezone, so "daily budget" resets at their midnight.
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: get('timezone') });

export function record(agentName, model, usage, opts) {
  const usd = costOf(model, usage, opts);
  db.prepare(`insert into costs (day, agent, model, input, output, cache_read, cache_write, usd)
    values (?, ?, ?, ?, ?, ?, ?, ?)`).run(today(), agentName, model, usage.input_tokens || 0,
    usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0, usd);
  return usd;
}

// Non-token spend (texts, calls) goes in the same ledger so the cost tracker and global cap see it.
export const recordUsd = (agentName, item, usd) =>
  db.prepare('insert into costs (day, agent, model, usd) values (?, ?, ?, ?)').run(today(), agentName, item, usd);

const spent = (where, ...args) =>
  db.prepare(`select coalesce(sum(usd), 0) s from costs where day = ? ${where}`).get(today(), ...args).s;

// Returns a reason string if the agent may NOT make another call, else null.
// ponytail: checks spend before the call, so one call can overshoot the cap by at most max_tokens worth.
export function blocked(name) {
  if (get('global_halt') === '1') return 'global kill switch is on';
  const a = agent(name);
  if (!a) return `unknown agent ${name}`;
  if (a.status === 'killed') return `${name} was killed`;
  if (spent('and agent = ?', name) >= a.daily_budget_usd) return `${name} hit its daily budget ($${a.daily_budget_usd})`;
  if (spent('') >= Number(get('global_daily_budget_usd'))) return 'global daily budget reached';
  return null;
}

export function summary() {
  const month = today().slice(0, 7);
  return {
    today: spent(''),
    month: db.prepare("select coalesce(sum(usd),0) s from costs where substr(day,1,7) = ?").get(month).s,
    byAgent: db.prepare('select agent, round(sum(usd), 4) usd, count(*) calls from costs where day = ? group by agent').all(today()),
    daily: db.prepare('select day, round(sum(usd), 4) usd from costs group by day order by day desc limit 30').all(),
  };
}
