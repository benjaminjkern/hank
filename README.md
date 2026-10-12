# Hank

**Let's get you hired.**

Tell Hank what you're after. It builds a watchlist of companies, scrapes their
job boards, reads every posting against your résumé, drafts your applications,
and keeps the board current — walking you through one company at a time while
you steer from the conversation.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

<!-- TODO: ADD SCREENSHOT -->

---

## What it does

- **Finds companies** worth watching from a description of what you want, and
  keeps notes on each one as you learn things.
- **Scrapes their job boards directly**, so postings come from the source
  rather than an aggregator — 19 ATS integrations (Greenhouse, Lever, Ashby,
  Workday, iCIMS, SmartRecruiters, and the hand-rolled boards at Google, Meta,
  Apple, Amazon, Netflix, Shopify…), and it teaches itself boards it doesn't
  recognize: an LLM works out an unknown board's structure once, then the
  learned recipe scrapes it like any other.
- **Reads each posting against your background** and tells you which roles are
  worth your time — and, more usefully, why the others aren't.
- **Drafts the application**, including the free-text questions the form
  actually asks, then runs the draft past a recruiter-lens critic before you
  see it.
- **Remembers.** What you're looking for, your location and compensation
  constraints, why you passed on a company six weeks ago, the answers you've
  already drafted to the questions every form asks — kept as durable notes and
  re-read on later turns.
- **Tracks the whole lifecycle** — applied, responded, interviewing, closed —
  on a dashboard that stays current without you updating it, with analytics on
  how the search is going.

## Try it

**Hosted:** [hank.so](https://hank.so) is in **private beta**. Sign in and hit
_Request access_ to join the waitlist — you'll be let in as spots open.

**Self-hosted:** three env vars and you're running — see
[Quick start](#quick-start). Your own instance, your own database, your data
stays yours.

Planning to run it for anyone besides yourself? Read
[docs/self-hosting.md](docs/self-hosting.md) first — Hank accumulates a detailed
picture of a person's working life, and hosting that for other people carries
obligations a single-user install doesn't.

## Quick start

**Prereqs:** Node 20+, pnpm, Docker (for the bundled Postgres — or bring your
own), and a [DeepSeek API key](https://platform.deepseek.com/).

```bash
pnpm install
cp .env.example .env      # then fill in the two values below
docker compose up -d      # local Postgres — matches .env.example as-is
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Two variables in `.env` and you're running:

| Variable           | What it's for                                                          |
| ------------------ | ---------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY` | Runs every LLM call                                                    |
| `SEED_ADMIN_EMAIL` | The email you'll sign in with — seeded as the admin account            |

Open http://localhost:3000, sign in with that email, attach your résumé with
the 📎 button, and tell Hank what you're looking for.

Everything else in [.env.example](.env.example) is optional and documented
inline — OAuth sign-in, an Anthropic key for the vision features (résumé-file
parsing, logo checks), web push notifications.

## How it works

One page, two surfaces:

- **The chat (left panel)** is where the work happens. Hank streams its replies, and
  anything that needs your call arrives inline as a widget — a role picker, a
  batch of companies to approve, a what's-next menu.
- **The dashboard (right panel)** shows what you're working on: a dashboard of your
  watchlist bucketed by who-acts-next, a page per company and per role — the
  posting, its history, your notes — the shortlist board where a scrape's
  results get ranked and settled, the application page with drafted answers
  ready to edit, and Documents / Analytics pages for your reusable materials
  and the state of the search. Every view has a URL, so refresh and Back work
  the way you'd expect.

## Stack

- **Next.js 16** App Router, **React 19**, **TypeScript**
- **Postgres** via **Prisma 7** (adapter pattern; client generated to
  `src/generated/prisma/`), with **Kysely** compiling batched per-row updates
- **styled-components 6** with SSR — no Tailwind, no CSS classes
- **Auth.js v5** — Google / GitHub OAuth, database-backed sessions
- **DeepSeek** for every LLM call; the **Anthropic SDK** for vision only
- **zod** at boundaries, **zustand** for client UI state
- **Playwright** for the headless-scrape path

## Documentation

[AGENTS.md](AGENTS.md) covers the project's conventions and setup gotchas.
[docs/self-hosting.md](docs/self-hosting.md) covers what Hank stores, who can
read it, and where it's sent. [docs/](docs/) goes deeper on specific areas — the
chat runtime, the job lifecycle and statuses, the scraper layer, agent tools and
sub-agents, memory, UI, and token cost.

## Where your data goes

Worth knowing before you run it, hosted or self-hosted: Hank sends your chat
messages and the prompts built from your résumé and profile notes to
**DeepSeek**, which runs the main agent and every sub-agent. **Anthropic**
receives résumé files and company logos for the two vision-only features. Full
detail in [docs/self-hosting.md](docs/self-hosting.md).

## Status

Hank is an actively developed prototype, built for my own job search
and shared in case it's useful to others. It works end to end, but it isn't
hardened for hostile multi-tenant use, and it currently has no account deletion,
data export, or retention policy — read [SECURITY.md](SECURITY.md) and
[docs/self-hosting.md](docs/self-hosting.md) before deploying it publicly.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright (C) 2026 Benjamin Kern.

Hank is free software licensed under the **GNU Affero General Public License
v3.0** — see [LICENSE](LICENSE). You may use, modify, and redistribute it; but
if you run a modified version as a network service, you must make its source
available to that service's users.
