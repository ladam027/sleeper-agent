# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
One owner, running a personal team of AI agents 24/7. They use the dashboard about equally on a laptop (long sessions: chatting with James, reviewing memory, money, clients) and on his phone over Tailscale (quick status checks and approvals).

## Product Purpose
Sleeper Agent is a private control room for the owner's agents (James the orchestrator, plus Pete, Riley, Theo, Cleo, Mia, Sam and others). The dashboard is where he talks to them, sees what they did and what it cost, approves risky actions, and manages memory, the vault, money, markets, clients, the live browser, the studio, integrations and settings. Success: he can trust what the agents are doing and act on anything that needs him within seconds. The current goal is +$1,000/month from local-business websites.

## Positioning
A one-person, self-hosted agent team with every money and side-effect limit enforced in code, and the owner as the only approver.

## Operating Context
- Single static `public/index.html`, vanilla JS, no build step; served on 127.0.0.1 and reached over Tailscale only.
- Pages: Overview (status, approvals, agents, reminders, scheduled tasks, activity feed, chat), Memory (graph), Vault, Money (projects, income engine, ledger), Markets, Clients, Browser (live view), Studio, Statistics, Integrations, Guide, Settings.
- Telegram is the phone channel for messages and approvals; the dashboard is the full view.

## Capabilities and Constraints
- Must keep the information density it has today; less info on screen is the main thing that would make a redesign feel wrong (owner, 2026-11-04).
- Never-access-vault rules apply to anyone working on the dashboard (CLAUDE.md rule 8).
- Light and dark modes.

## Brand Commitments
- The owner's house design spec governs the app: calm, flat, Apple-like; one palette of cream, ink and yolk yellow; pill buttons; hairline cards; no glows, gradients or heavy shadows; system SF/Inter; lucide-style stroke icons, never emoji; short, specific, human copy. The owner confirmed on 2026-11-04 that the dashboard follows it.

## Evidence on Hand
Real agent names, model names and budgets live in the app; no customer testimonials or public claims exist and none should be invented.

## Product Principles
- The owner sees what needs him first: approvals, kill switch, spend.
- Density over decoration: every pixel either shows state or lets him act.
- Money and risk are always legible: figures in tabular numerals, state colours only where they carry meaning.
- Calm by default; colour and motion explain what changed.
