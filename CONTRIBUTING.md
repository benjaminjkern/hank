# Contributing to Hank

Thanks for your interest. Hank is an actively developed prototype with one
maintainer, so before writing code for anything substantial, please **open an
issue** — parts of the codebase change quickly and a short exchange can save you
a lot of rework.

Small fixes (typos, broken links, an obvious bug) don't need an issue first.
Just open a PR.

## Getting set up

Setup is the README's [Quick start](README.md#quick-start): one API key,
`docker compose up -d` for Postgres, migrate, `pnpm dev`. That gives you
a live instance to develop against, and the bundled Docker Postgres is your
sandbox — the dev server, `pnpm db:*`, and every script under `scripts/` all
talk to whatever `DATABASE_URL` points at.

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

## Pull requests

- Branch off `main`.
- Keep it focused — one change per PR is much easier to review.
- Describe what changed and how you verified it.
- If your change affects the agent's behavior, say what you saw it do
  differently. CI can't check that.
- Update any docs your change makes wrong.

## LLM harnesses cost real money

The harnesses under `scripts/regression/` and `scripts/audits/`, and
`pnpm scenarios`, make live LLM API calls billed to whoever runs them. None of
them run in CI and none are expected for a normal PR — if you think your change
warrants one, say so in the PR and the maintainer can run it.

## Project conventions

The codebase has a few house rules — layering, naming, and how database writes
are batched. They're documented in [AGENTS.md](AGENTS.md), and the linter
enforces the ones that matter most, so you'll usually find out before a reviewer
has to tell you.

## Security

Please don't report security issues in a public issue — see
[SECURITY.md](SECURITY.md).

## License and CLA

Hank is licensed under the [GNU AGPL v3.0](LICENSE). Before your first pull
request is merged, you'll be asked to sign the project's
[Contributor License Agreement](CLA.md) — a bot comments on the PR, and signing
is a single reply. You keep the copyright to your contribution; the CLA licenses
it to the project.
