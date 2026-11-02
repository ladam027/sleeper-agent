# Build 4: Money cockpit

## Part 1 (v4.0.0): no outside accounts needed
- `src/money.js`: projects (status, progress, goal, monthly target), ledger (+income/−expense), `moneySummary()` with per-project month/all-time income, expenses, AI spend of agents assigned to the project (`agents.project_id`), net and ROI; overall totals incl. AI and phone spend vs the monthly income goal (`monthly_income_goal`, default 1000). CRM contacts (stages lead→contacted→replied→meeting→client/lost, next step + date, last touch). Email drafts (never sent automatically).
- Agent tools: `project`, `list_projects`, `log_money`, `contact`, `list_contacts`, `draft_email`; `create_agent` takes `project`. Pete gets `list_projects`, `list_contacts`.
- Dashboard: **Money** tab (goal KPIs, project cards with progress/target/ROI, income vs spending chart, log form, ledger, plus the old Costs charts) and **Clients** tab (CRM with inline stage changes, overdue follow-ups in red, drafts with copy / mark sent / discard). Costs tab merged into Money. Mobile tab bar fits 7 items.
- Deploy tooling (Build 2 leftover): `npm run deploy` (`scripts/deploy.sh`): setup, move, update. See docs/DEPLOY.md.
- Schema v9. 47 tests (5 new).

## Part 2 (needs the owner's accounts)
- Google OAuth (one Google Cloud project, "testing" mode): Gmail digest (read-only) of the owner's inbox, the agent's own Gmail for sending approved drafts, Google Calendar events.
- GitHub publishing via a fine-grained token (approval per publish).
