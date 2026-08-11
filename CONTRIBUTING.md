# Contributing to Hank

Thanks for your interest. Hank is an actively developed prototype with one
maintainer, so before writing code for anything substantial, please **open an
issue** — parts of the codebase change quickly and a short exchange can save you
a lot of rework.

Small fixes (typos, broken links, an obvious bug) don't need an issue first.
Just open a PR.

## Getting set up

You'll need Node 20+, pnpm, a Postgres database, and a
[DeepSeek API key](https://platform.deepseek.com/).

```bash
pnpm install                    # postinstall runs `prisma generate`
cp .env.example .env            # then fill it in — see the README
docker compose up -d            # optional: starts a local Postgres
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Full setup details, including what each environment variable is for, are in the
[README](README.md#quick-start).

> **Heads up:** there is no separate test database. `pnpm db:*` and every script
> under `scripts/` connect to whatever `DATABASE_URL` points at. Point it at a
> database you own before running anything that writes.

## Before you open a PR

```bash
pnpm format            # Prettier — owns all formatting
pnpm lint              # must be zero errors; warnings are advisory
pnpm exec tsc --noEmit # must be clean
```

CI runs these on every pull request, so anything that fails here will fail
there.

Formatting and linting don't overlap: Prettier owns whitespace and wrapping,
ESLint owns correctness. Run `pnpm format` rather than adjusting whitespace by
hand.

> **Some scripts cost real money.** The harnesses under `scripts/regression/`
> and `scripts/audits/`, and `pnpm scenarios`, make live LLM API calls billed to
> whoever runs them. Don't run them casually. If you think your change needs
> one, say so in the PR.

## Database changes

Schema changes take four steps, and skipping the third is the usual mistake —
this project does **not** auto-generate SQL from schema edits:

1. Edit `prisma/schema.prisma`
2. `pnpm db:generate` so the typechecker sees the new columns
3. Hand-write the migration SQL in
   `prisma/migrations/<timestamp>_<name>/migration.sql`
4. `pnpm db:migrate` to apply it

If your change reshapes existing rows, include the backfill in the same
migration.

## Adding an ATS scraper

This is probably the most self-contained way to contribute. Each job board
provider is a single file under `src/server/scrape/ats/providers/` — start from
`greenhouse.ts` or `lever.ts` for a simple example. See
[docs/ats-scrapers.md](docs/ats-scrapers.md).

## Pull requests

- Branch off `main`.
- Keep it focused — one change per PR is much easier to review.
- Describe what changed and how you verified it.
- If your change affects the agent's behavior, say what you saw it do
  differently. CI can't check that.
- Update any docs your change makes wrong.

## Project conventions

The codebase has a few house rules — layering, naming, and how database writes
are batched. They're documented in [AGENTS.md](AGENTS.md), and the linter
enforces the ones that matter most, so you'll usually find out before a reviewer
has to tell you.

## Security

Please don't report security issues in a public issue — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree your contributions will be licensed under the
[GNU AGPL v3.0](LICENSE), the same license as the project.
