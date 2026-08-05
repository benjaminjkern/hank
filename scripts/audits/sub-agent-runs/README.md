# Sub-agent runtime audit

Audits the **real production outputs** of Hank's sub-agents. Where the static
[`scripts/regression/sub-agents/`](../../regression/sub-agents/) suite runs each sub-agent
against **synthetic fixtures**, and [`scripts/audits/sessions/`](../sessions/)
audits the **user-visible chat surface**, this harness looks at **what the
sub-agents actually returned in production** — the piece neither of the others
sees.

For each sub-agent it does two things per real run:

1. **Weird-output check** — Opus 4.8 judges whether the actual response was
   wrong / off-target / hallucinated / inconsistent / leaking internal
   vocabulary. Files an AdminNote (`category=tool_misbehavior`,
   `dedupKey=subagent_runtime:weird_output:<operation>:<shape>`).
2. **Coverage-gap check** — Opus compares the run's _use-case shape_ against that
   sub-agent's static fixtures and, when the shape isn't covered, files an
   AdminNote (`category=self_improvement`,
   `dedupKey=subagent_coverage_gap:<operation>:<shape>`) with a suggested fixture
   stub to paste into the matching audit script.

## How the data gets there

Sub-agent inputs/outputs were never persisted before this. Now every real run is
captured to the **`SubAgentRun`** table by
[`recordSubAgentRun`](../../../src/server/subagents/lib/subAgentRun.ts), wired at the
ONE chokepoint every sub-agent goes through — `runSubAgent`. Capture is
unconditional and untruncated (binary image/PDF bytes are redacted; everything
else is kept). The `class` column is derived there from whether the run got read
tools, which is the only mechanical difference judgement and transform have.

Synthetic/ephemeral harnesses set `HANK_DISABLE_SUBAGENT_CAPTURE=1` so their runs
don't pollute the table (the static sub-agent-audits via `lib/judge.ts`, plus
qa-audit and the shortlist replay).

## Fixture registry (drift-free)

[`fixtureRegistry.ts`](./fixtureRegistry.ts) imports the `export`ed `FIXTURES`
from each of the 14 audit scripts (each now guards its top-level run with
`isEntrypoint(import.meta.url)` so importing is side-effect-free). The coverage
check compares real runs against the **actual** static fixtures, not a copy.

## Coverage

All 14 active judgement/transform sub-agents have a static audit AND are
captured. The two audit-less operation names (`whats_next`, `eval_fit`) have no
active LLM call site (removed in the pipeline overhaul) so produce no rows; if
either is re-wired the auditor treats it as zero-coverage until a static audit
exists. The main streaming agent (`chat`) is intentionally not captured — it's
covered by qa-audit + session-audit.

## Running

```bash
pnpm audit:sub-agent-runs                       # audit all new runs since the cursor
pnpm audit:sub-agent-runs --dry-run             # zero-spend, zero-write, no cursor advance
pnpm audit:sub-agent-runs --only shortlist_jobs # one operation
pnpm audit:sub-agent-runs --since-iso 2026-06-20T00:00:00Z   # ignore cursor, start from a date
pnpm audit:sub-agent-runs --chunk-size 8 --model claude-sonnet-4-6

# One-time bootstrap seed (only application_decider is reconstructable):
pnpm audit:sub-agent-runs:backfill              # dry-run
pnpm audit:sub-agent-runs:backfill --apply
```

Hits whatever `DATABASE_URL` points at (prod, per AGENTS.md). Findings file live
via `upsertAdminNote` per chunk; the per-operation cursor
(`.subagent-runtime-audit-cursor.json`) advances after each chunk, so a crash
resumes cleanly. Reports land in `artifacts/`.

This harness reads captured `SubAgentRun` rows and re-runs no sub-agent, so it's
100% grader spend — billing the auditor to your Claude subscription moves the
whole run off the API key. See [../lib/GRADER_BILLING.md](../../lib/GRADER_BILLING.md).

## Cursor

One entry per operation (operations interleave in time, so a single global
timestamp would skip un-audited runs):

```json
{
  "lastAuditAt": "…",
  "lastAuditModel": "claude-opus-4-8",
  "lastAuditFindings": 0,
  "perOperation": {
    "shortlist_jobs": { "lastRunId": "…", "lastRunCreatedAt": "…" }
  }
}
```
