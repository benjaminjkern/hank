# QA-audit harness

An Opus 4.8 agent role-plays a fleshed-out user persona and holds a real
multi-turn conversation with the **live Hank pipeline** (driven in-process via
`runUserMessage` — the same function `/api/chat` calls). Each turn the persona
sees only a TEXT reconstruction of what a real user would see: Hank's chat
reply, any on-screen widget rendered to text, and a one-line right-panel hint.
It logs its thinking, takes one action (type a message, or "click" a widget),
assesses Hank, and can **halt** the whole run on something major.

## Run it

Hank-under-test runs on DeepSeek (`deepseek-v4-pro`), the sole chat provider — and the weaker model is the stricter test for the no-internal-vocab / no-confabulation discipline (a leak a stronger model would hide shows up here). The Opus 4.8 persona simulator is unaffected (it builds its own Anthropic client). DeepSeek-Hank is far cheaper, so the `--spend-cap` mostly bounds the Opus persona. Scope to the personas that exercise what you changed (`--persona <id>`) rather than always sweeping all seven.

```bash
# zero-spend, no DB writes — verifies the widget markers round-trip through
# the real server parsers. Run this first (no LLM calls).
pnpm exec tsx scripts/regression/conversations/run.ts --dry-run

# one short persona, tiny cap — cheap live smoke test
pnpm exec tsx scripts/regression/conversations/run.ts --persona 01-has-targets --max-turns 3 --spend-cap 0.50

# a targeted persona or two (the ones that exercise your change)
pnpm exec tsx scripts/regression/conversations/run.ts --persona 05-picky-skipper --spend-cap 5

# full sweep (all personas, sequential), defaults: 12 turns, $15 cap
pnpm exec tsx scripts/regression/conversations/run.ts

# crash recovery: tear down any leftover ephemeral users from a run
pnpm exec tsx scripts/regression/conversations/run.ts --cleanup --run <runId>
```

## Important: this writes to PROD

The shared DB is Railway prod (see AGENTS.md). The harness creates an
**ephemeral, tagged `User` + `ChatSession` per persona** and **hard-deletes
everything it wrote** in a `finally` (normal end, halt, spend-abort, or crash).
After each persona it asserts zero residue. Global `Company`/`Job` catalog rows
that Hank creates are **left in place** — they're shared and deduplicated by
slug; deleting one a real user also watches would be data loss. Personas use
real company names to keep that catalog clean.

Both sides spend real credit: the Opus persona (Anthropic) **and** Hank's own
DeepSeek calls. The `--spend-cap` (default $15) sums both and
aborts the experiment when exceeded.

To bill the Opus persona to your Claude subscription instead of the API key
(then it's excluded from `--spend-cap`, which bounds only Hank-under-test), see
[../lib/GRADER_BILLING.md](../../lib/GRADER_BILLING.md).

## Output

`scripts/regression/conversations/artifacts/<runId>/` (gitignored):

- `<persona>.jsonl` — one line per turn (perception, thoughts, action, assessment, halt, cost), appended live.
- `<persona>.md` — thought logs + overall perspective + terse lossless summary + halt callout.
- `index.md` — run config, per-persona end-reason/halt/residue table, total spend, global halt.

## Layout

- `personas/` — the persona definitions + ordered manifest.
- `driver/` — `turnDriver` (consume `runUserMessage`), `widgetRender` (payload→text + action→marker), `panelHint`.
- `agent/` — `personaAgent` (Opus loop), `schemas` (forced tools), `perception` (VisibleTurn→persona text + leak scan).
- `isolation/` — ephemeral user setup + mandatory teardown + crash cleanup.
- `lib/` — tags, spend accountant.
- `report/` — transcript + markdown writers + `assertions.ts` (post-run deterministic regression checks over the transcript: `turns_to_value`, `no_internal_status`, `no_raw_internals_in_chat`, and `no_confabulated_widgets` — the last flags Hank drawing an on-screen role menu / shortlist / picker in prose, via the shared [`detectFabricatedUiRender`](../../../src/server/agent/session/uiProvenance.ts); hard hits fail, fuzzy widget-shaped prose is reported for review).
- `verify/` — the dry-run marker round-trip.
