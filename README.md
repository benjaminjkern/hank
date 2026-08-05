# Hank

A chat-first job application tool. The agent walks your watchlist one company at a time — discovering jobs, drafting cover letters, and tracking application state — while you steer from chat. Sign in via Google or GitHub.

Two surfaces in one page:

- **Left** — chat panel (streaming text + tool-use chips).
- **Right** — mode-switching panel: dashboard / company-context / job-detail / opportunity-detail. The panel is client-managed and browsing it never disturbs the conversation: there's no persisted "current company" to knock out of place — the agent works from the chat and the entity you name, and each switch drops a clickable chip in the transcript. See [docs/architecture.md](docs/architecture.md).

## Stack

- **Next.js 16** App Router, **React 19**, **TypeScript**. This is not the Next.js your training data knows — see [AGENTS.md](AGENTS.md) and `node_modules/next/dist/docs/`.
- **styled-components 6** with SSR via [src/lib/registry.tsx](src/lib/registry.tsx); theme tokens in [src/lib/theme.ts](src/lib/theme.ts). No Tailwind, no CSS classes.
- **Prisma 7** with the adapter pattern — see [src/server/db/prisma.ts](src/server/db/prisma.ts). Client is generated to `src/generated/prisma/` (import from `@/generated/prisma/client`).
- **Postgres** (the reference deployment is Railway-hosted; point `.env`'s `DATABASE_URL` at your own instance).
- **DeepSeek** runs every LLM call — the main agent and every sub-agent, including the chat summarizer ([compactSummary.ts](src/server/subagents/registry/compactSummary.ts), driven by [compactSession.ts](src/server/procedures/registry/compactSession.ts)). The **Anthropic SDK** survives for the vision carve-out only (resume parsing + logo verification). See [docs/llm-providers.md](docs/llm-providers.md).
- **zod** for boundary validation, **zustand** for client UI state.

## Quick start

Prereqs: Node 20+, pnpm, a Postgres database, a DeepSeek API key (an Anthropic key is optional — vision only).

```bash
# 1. Install deps
pnpm install

# 2. Configure env
cp .env.example .env
# then edit .env:
#   DATABASE_URL        — Postgres connection string
#   DEEPSEEK_API_KEY    — runs every LLM call (main agent + all sub-agents)
#   ANTHROPIC_API_KEY   — optional; vision only (resume parsing + logo verification)
#   ANTHROPIC_KEY_ENCRYPTION_KEY — openssl rand -base64 32 (encrypts per-user keys at rest)
#   AUTH_SECRET         — openssl rand -base64 32
#   AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET   — Google OAuth client
#   AUTH_GITHUB_ID / AUTH_GITHUB_SECRET   — GitHub OAuth app
#   SEED_ADMIN_EMAIL    — the email that gets isAdmin=true on seed

# 3. Migrate + seed
pnpm db:migrate
pnpm db:seed

# 4. Run
pnpm dev
```

Open http://localhost:3000. Sign in, drop your resume via the 📎 button, tell Hank what you're looking for, and let it build a watchlist.

## Scripts

| Command            | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `pnpm dev`         | Next dev server.                                          |
| `pnpm build`       | Production build (type-checks).                           |
| `pnpm lint`        | ESLint.                                                   |
| `pnpm db:migrate`  | `prisma migrate deploy` against `DATABASE_URL`.           |
| `pnpm db:seed`     | Upsert the admin user (`SEED_ADMIN_EMAIL`).               |
| `pnpm db:studio`   | Open Prisma Studio.                                       |
| `pnpm db:generate` | Regenerate the Prisma client into `src/generated/prisma`. |
| `pnpm usage`       | Print a token-usage summary by operation.                 |

## Where to look next

- [AGENTS.md](AGENTS.md) — the single source of project instructions: orientation, the detail-docs index, conventions, and the Next.js 16 / Prisma / Auth.js / worktree gotchas that may diverge from training data. (CLAUDE.md just points here.)
- [docs/](docs/) — architecture, lifecycle, flows, tools, sub-agents, memory, UI, cost, admin. AGENTS.md has the index with one-line summaries.

## License

Copyright (C) 2026 Benjamin Kern.

Hank is free software licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE). You may use, modify, and redistribute it; but if you run a modified version as a network service, you must make its source available to that service's users.
