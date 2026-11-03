// Usage statistics per agent over a time span, a breakdown of where the money goes, and cost-saving insights
// computed from the actual ledger (each with an estimated monthly saving and, where possible, a one-click fix).
import { db, get } from './db.js';
import { PRICES, today } from './budget.js';

const SPANS = { today: 1, '7d': 7, '30d': 30, all: 3650 };
const dayMinus = (n) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - (n - 1)); return d.toISOString().slice(0, 10); };

// Split each ledger row into what it paid for. Remainder on token rows = web searches (or batch discount).
function components(r) {
  const p = PRICES[r.model];
  if (!p) return { phone: r.usd };
  const c = { input: r.input * p.input / 1e6, cache_write: r.cache_write * p.cacheWrite / 1e6, cache_read: r.cache_read * p.cacheRead / 1e6, output: r.output * p.output / 1e6 };
  const extra = r.usd - (c.input + c.cache_write + c.cache_read + c.output);
  if (extra > 0.0005) c.web_search = extra;
  return c;
}

export function stats(span = '7d') {
  const days = SPANS[span] || 7, since = dayMinus(days), elapsed = Math.max(1, Math.min(days, db.prepare('select count(distinct day) n from costs where day >= ?').get(since).n || 1));
  const rows = db.prepare('select * from costs where day >= ?').all(since);
  const names = Object.fromEntries(db.prepare('select name, display_name, model, effort, web from agents').all().map((a) => [a.name, a]));
  const agents = {}, breakdown = { input: 0, cache_write: 0, cache_read: 0, output: 0, web_search: 0, phone: 0 }, daily = {};
  for (const r of rows) {
    const a = agents[r.agent] ||= { agent: r.agent, label: names[r.agent]?.display_name || r.agent, models: new Set(), usd: 0, calls: 0, input: 0, cache_read: 0, cache_write: 0, output: 0, parts: {} };
    a.usd += r.usd; a.calls++; a.models.add(r.model);
    for (const k of ['input', 'cache_read', 'cache_write', 'output']) a[k] += r[k] || 0;
    for (const [k, v] of Object.entries(components(r))) { breakdown[k] += v; a.parts[k] = (a.parts[k] || 0) + v; }
    ((daily[r.day] ||= {})[r.agent] = (daily[r.day][r.agent] || 0) + r.usd);
  }
  const total = rows.reduce((s, r) => s + r.usd, 0);
  const list = Object.values(agents).map((a) => ({ ...a, models: [...a.models], share: total ? a.usd / total : 0, per_call: a.usd / a.calls,
    cache_hit: (a.cache_read + a.cache_write + a.input) ? a.cache_read / (a.cache_read + a.cache_write + a.input) : null })).sort((x, y) => y.usd - x.usd);
  const routes = db.prepare("select detail from activity where type = 'route' and date(ts) >= ?").all(since).map((r) => r.detail);
  const out = { span, since, days: elapsed, total, per_day: total / elapsed, projected_month: total / elapsed * 30, calls: rows.length, agents: list, breakdown,
    daily: Object.entries(daily).sort().map(([day, by]) => ({ day, ...by })),
    routing: { to_james: routes.filter((d) => d.startsWith('orchestrator')).length, to_pete: routes.filter((d) => d.startsWith('quick')).length, escalated: routes.filter((d) => d.includes('escalated')).length } };
  out.insights = insights(out, names);
  return out;
}

const per30 = (usd, s) => usd / s.days * 30;
export function insights(s, names) {
  const tips = [], tokenSpend = s.breakdown.input + s.breakdown.cache_write + s.breakdown.cache_read + s.breakdown.output;
  if (s.calls < 5) return [{ title: 'Not enough data yet', detail: 'Tips appear after a few dozen agent calls in this time span.', saves: 0 }];
  const A = Object.fromEntries(s.agents.map((a) => [a.agent, a]));

  if (tokenSpend && s.breakdown.cache_write / tokenSpend > 0.25) tips.push({ title: 'Cache writes are a big share of spend',
    detail: `${Math.round(s.breakdown.cache_write / tokenSpend * 100)}% of model spend went to writing conversations into the prompt cache, which expires after 5 minutes. Since v4.8 only the stable part (instructions + tools) is cached between messages, and whole conversations only within multi-step tasks. This number should fall from here on.`,
    saves: per30(s.breakdown.cache_write * 0.6, s) });

  const james = A.orchestrator, jm = names.orchestrator;
  if (james && james.parts.output > james.usd * 0.25 && jm?.effort !== 'low') tips.push({ title: "Lower James's effort",
    detail: `James's thinking + replies (billed as output) cost ${money(james.parts.output)} in this span. "Low" effort usually cuts that by a third or more on everyday tasks; raise it only for big decisions.`,
    saves: per30(james.parts.output * 0.35, s), apply: { kind: 'agent', agent: 'orchestrator', body: { effort: 'low' }, label: 'Set James to low effort' } });

  const riley = A.researcher;
  if (riley && riley.per_call > 0.06) tips.push({ title: 'Research steps are expensive',
    detail: `Each research step averages ${money(riley.per_call)}, mostly from reading search results and pages. Pages are now capped in length and searches limited per step; asking Riley one focused question at a time (instead of "research everything about…") cuts it further.`,
    saves: per30(riley.usd * 0.3, s) });

  const hist = Number(get('history_limit') || 12);
  if (james && james.calls >= 5 && (james.input + james.cache_read + james.cache_write) / james.calls > 15000 && hist > 6) tips.push({ title: 'Long conversation history',
    detail: `James reads about ${Math.round((james.input + james.cache_read + james.cache_write) / james.calls / 1000)}k tokens per call. Sending fewer past messages (memory still keeps long-term facts) makes every call cheaper.`,
    saves: per30(james.usd * 0.15, s), apply: { kind: 'setting', body: { history_limit: 6 }, label: 'Keep only the last 6 messages' } });

  const r = s.routing, routed = r.to_james + r.to_pete;
  if (routed >= 5 && r.to_james / routed > 0.6) tips.push({ title: 'Most messages go to James (Opus)',
    detail: `${r.to_james} of ${routed} messages in this span went to James. Short questions, lookups and reminders are 4–20× cheaper on Pete; words like plan, research, analyze or business send a message to James. Keep everyday questions short and simple.`,
    saves: per30((A.orchestrator?.per_call || 0) * r.to_james * 0.3 * 0.75, s) });

  const bg = ['security', 'memory', 'reader'].reduce((t, k) => t + (A[k]?.usd || 0), 0);
  if (s.total && bg / s.total < 0.1) tips.push({ title: 'Background agents are cheap', detail: `Security audits, memory cleanup and document reading are ${money(bg)} (${Math.round(bg / s.total * 100)}%) of spend. No change needed.`, saves: 0 });

  if (s.projected_month > Number(get('global_daily_budget_usd')) * 30 * 0.8) tips.push({ title: 'On track to hit your budget',
    detail: `At this pace you'd spend about ${money(s.projected_month)} a month. Applying the tips above, or lowering the daily cap in Settings, keeps you in check.`, saves: 0 });
  return tips.sort((a, b) => b.saves - a.saves);
}
const money = (n) => `$${Number(n || 0).toFixed(n < 1 ? 3 : 2)}`;
