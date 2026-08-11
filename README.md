# Hank

**A job search that runs itself, steered from a chat window.**

Tell Hank what you're after. It builds a watchlist of companies, scrapes their
job boards, reads every posting against your résumé, drafts your applications,
and keeps the board current — walking you through one company at a time while
you steer from the conversation.

[![CI](https://github.com/benjaminjkern/hank/actions/workflows/ci.yml/badge.svg)](https://github.com/benjaminjkern/hank/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

<!-- SCREENSHOT -->

---

## What it does

Most job trackers are spreadsheets you have to feed. Hank does the feeding:

- **Finds companies** worth watching from a description of what you want, and
  keeps notes on each one as you learn things.
- **Scrapes their job boards directly** — 19 ATS integrations (Greenhouse,
  Lever, Ashby, Workday, iCIMS, SmartRecruiters, and the hand-rolled boards at
  Google, Meta, Apple, Amazon, Netflix, Shopify…), so postings come from the
  source rather than an aggregator.
- **Reads each posting against your background** and tells you which roles are
  worth your time — and, more usefully, why the others aren't.
- **Drafts the application**, including the free-text questions the form
  actually asks, then runs the draft past a recruiter-lens critic before you
  see it.
- **Tracks the whole lifecycle** — applied, responded, interviewing, closed — on
  a dashboard that stays current without you updating it.
- **Remembers.** What you said about compensation, location, why you passed on a
  company six weeks ago: it's kept as durable notes and re-read on later turns.

## Try it

**Hosted:** [hank.so](https://hank.so)

**Self-hosted:** see [Quick start](#quick-start). Hank is AGPL — run your own
instance, point it at your own database, and your data stays yours.

Planning to run it for anyone besides yourself? Read
[docs/self-hosting.md](docs/self-hosting.md) first — Hank accumulates a detailed
picture of a person's working life, and hosting that for other people carries
obligations a single-user install doesn't.

## Quick start

**Prereqs:** Node 20+, pnpm, Postgres, and a
[DeepSeek API key](https://platform.deepseek.com/). An Anthropic key is optional
— it's used only for vision (résumé parsing and logo verification).

```bash
pnpm install
cp .env.example .env
docker compose up -d      # optional — starts Postgres locally
```

Fill in `.env`:

| Variable                                | What it's for                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                          | Postgres connection string (the default matches `docker-compose.yml`)                                                                  |
| `DEEPSEEK_API_KEY`                      | Runs every LLM call — the main agent and all sub-agents                                                                                |
| `ANTHROPIC_KEY_ENCRYPTION_KEY`          | `openssl rand -base64 32` — encrypts per-user keys at rest                                                                             |
| `AUTH_SECRET`                           | `openssl rand -base64 32`                                                                                                              |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | A [GitHub OAuth app](https://github.com/settings/developers) — callback URL `http://localhost:3000/api/auth/callback/github`           |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | A Google OAuth client (optional if you sign in with GitHub)                                                                            |
| `SEED_ADMIN_EMAIL`                      | The email that gets admin on seed — use the one you'll sign in with                                                                    |
| `ANTHROPIC_API_KEY`                     | Optional; vision only                                                                                                                  |

Then:

```bash
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open http://localhost:3000, sign in, attach your résumé with the 📎 button, and
tell Hank what you're looking for.

> **First-run gotcha.** `DEEPSEEK_API_KEY` is available as a _server_ key, but
> each account must be allowed to spend it — the per-user `canUseServerKey` flag
> defaults to `false`. So on a fresh install the chat asks you for an API key
> even though you set one. Either paste your key into that prompt (stored
> encrypted, per-user) or flip the toggle for your user at `/admin/users`.

## How it works

Two surfaces in one page:

- **Left** — the chat panel: streaming replies, tool-use chips, and inline
  widgets (job pickers, checklists, shortlist boards).
- **Right** — an addressable panel that mirrors its breadcrumb into the URL
  (`/dashboard/stripe/stripe-sre/application`), so refresh restores it and Back
  walks your own navigation. Browsing it never disturbs the conversation.

## Stack

- **Next.js 16** App Router, **React 19**, **TypeScript**
- **Postgres** via **Prisma 7** (adapter pattern; client generated to
  `src/generated/prisma/`), with **Kysely** compiling batched per-row updates
- **styled-components 6** with SSR — no Tailwind, no CSS classes
- **Auth.js v5** — Google / GitHub OAuth, database-backed sessions
- **DeepSeek** for every LLM call; the **Anthropic SDK** for vision only
- **zod** at boundaries, **zustand** for client UI state
- **Playwright** for the headless-scrape path

## Scripts

| Command            | What it does                                    |
| ------------------ | ----------------------------------------------- |
| `pnpm dev`         | Next dev server                                 |
| `pnpm build`       | Production build (type-checks)                  |
| `pnpm lint`        | ESLint — zero errors is the merge bar           |
| `pnpm format`      | Prettier — owns all formatting                  |
| `pnpm db:migrate`  | `prisma migrate deploy` against `DATABASE_URL`  |
| `pnpm db:seed`     | Upsert the admin user (`SEED_ADMIN_EMAIL`)      |
| `pnpm db:generate` | Regenerate the Prisma client                    |
| `pnpm db:studio`   | Open Prisma Studio                              |
| `pnpm usage`       | Token-usage summary by operation                |

Several harnesses under `scripts/` make live LLM calls and cost real money — see
[CONTRIBUTING.md](CONTRIBUTING.md#before-you-open-a-pr) before running one.

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

Hank is an actively developed prototype, built for its author's own job search
and shared in case it's useful to others. It works end to end, but it isn't
hardened for hostile multi-tenant use, and it currently has no account deletion,
data export, or retention policy — read [SECURITY.md](SECURITY.md) and
[docs/self-hosting.md](docs/self-hosting.md) before deploying it publicly.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Adding an ATS
scraper is the most self-contained way in.

## License

Copyright (C) 2026 Benjamin Kern.

Hank is free software licensed under the **GNU Affero General Public License
v3.0** — see [LICENSE](LICENSE). You may use, modify, and redistribute it; but
if you run a modified version as a network service, you must make its source
available to that service's users.
