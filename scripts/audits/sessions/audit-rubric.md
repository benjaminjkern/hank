# Session audit rubric

The `pnpm audit:sessions` script ([scripts/audits/sessions/audit.ts](audit.ts)) ships this rubric to Opus 4.8 along with the session data. The auditor uses it to decide what counts as a finding, how to frame it, and what severity to pick. Keep this file tight — it sits in the cached prefix of every audit prompt, so prose bloat costs $$ over time.

## What counts as a finding

A finding is something a future Hank session would benefit from fixing. Cosmetic preferences ("I'd have phrased it differently") don't count; behaviors that recur and cost the user time/cost/correctness do.

Each finding gets shipped as one row to `upsertAdminNote`. The shape:

```ts
{
  (category, severity, summary, context, dedupKey);
}
```

## Categories

Pick the one closest to the finding's nature. The category drives where it shows up on the `/admin/notes` triage view.

- **`tool_misbehavior`** — A tool (or sub-agent) returned an error, returned wrong-shape output, hit a limit, or worked but with poor quality. Examples: scrape returned 200 chars on a real careers page; `shortlistJobsSubAgent` hit max_tokens; `draft_application` emitted a freeform blob instead of `[{question, answer}]`; `get_application_form` returned `unsupported` on a Greenhouse host. **The full drafted cover letter / short answers, company & job notes, and memory files are visible in each turn's out-of-chat snapshot** (see the README's Coverage section), so a "worked but poor quality" draft finding — fabricated or mis-attributed experience, ignored `frequent_questions.md` templates, AI-tell phrasing (em-dash pile-ups, "not X, but Y") — can be grounded in the actual persisted artifact, not just its chat echo.
- **`agent_confusion`** — The main agent reached the wrong conclusion, picked the wrong tool, passed the wrong arg shape, or got confused between similar concepts. Examples: passed a `companyId` to `update_jobs_status({jobIds})`; passed a `JobDeferReason` (`OUTRANKED`) to `pause_company` (which takes a `CompanyPauseReason`); routed `set_focus` to the wrong entity; lost track of focus during a multi-job walkthrough.
- **`user_confusion`** — The user signaled confusion, frustration, repetition, or visible doubt. Quote the user's exact phrase in `context`. The system prompt's "Watch the user for confusion signals" section enumerates the trigger patterns ("no", "try harder", "huh?", "...", repeated rephrasing, user does the work themselves).
- **`flow_friction`** — A documented flow rule was violated, OR the flow produced friction even when no rule was broken. Examples: agent didn't `compact_chat` between companies; `update_company_status(CLOSED)` left orphan NEW jobs behind; agent asked "want me to do X?" at a non-decision-point ("act, don't ask" violation); APPLIED logged on the wrong job because the focused entity wasn't switched first.
- **`capability_request`** — Hank tried to do something the system can't do today and a new capability would close the gap. Examples: new ATS pattern with no scraper; no `--bulk-skip-by-company` shorthand on `update_jobs_status`; no widget for "duplicate posting decision"; no client-side error reporting from the UI back to the agent.
- **`self_improvement`** — Hank should have pattern-matched this with existing tools instead of doing a manual dance. Distinct from `capability_request`: self_improvement is "the tool exists, the agent failed to use it"; capability_request is "no tool exists." Examples: agent re-ran `search_jobs` after every status flip instead of trusting cached data; agent did a multi-step inference dance to dedup roles when `update_job` would have been one call.

## Severity guide

- **`HIGH`** — A tool literally broke; the user gave up; the user was visibly frustrated; a known-good case (Greenhouse URL, broad query, focused job submit) failed in a way the user noticed; data integrity is compromised in a way the user will eventually trip over (orphan rows at terminal companies, status drift).
- **`MEDIUM`** — Real friction that got worked around. The user might not have noticed but the next session will hit the same wall. Default if unsure.
- **`LOW`** — Cosmetic; mild friction; one-off translation slip that didn't reach the user. File anyway — the cost of dismissing in two seconds is lower than the cost of missing a pattern.

The system prompt's discipline says: "False positives are cheap, false negatives are expensive." Be honest, not generous. If the agent did N silent workarounds, that's N findings, not one umbrella.

## dedupKey convention

Shape: `<source>:<failure_mode>:<input_shape>`. The dedupKey is what makes recurring findings collapse into one row with an `occurrenceCount`. Two findings with the same dedupKey get merged.

Examples lifted from past audits:

- `chat_loop:silent_after_compaction`
- `draft_application:parent_prompt:lazy_qualifier_grouping`
- `draft_application:persistence:freeform_blob`
- `data:orphaned_mid_flight_jobs:terminal_company`
- `agent_confusion:companyId_passed_as_jobId`
- `agent_confusion:enum_collision:job_vs_company_deferReason`
- `translation_discipline:enum_leak_in_chat`
- `diligence:silent_workaround_pattern`
- `shortlistJobsSubAgent:max_tokens_4096_too_low`
- `get_application_form:unsupported:greenhouse`
- `flow_friction:applied:grouped_jobs`

Conventions:

- Lowercase, snake_case-ish, colon-separated.
- First segment names the source tool / flow / pattern (`draft_application`, `chat_loop`, `agent_confusion`, `translation_discipline`).
- Middle segment names the failure mode.
- Last segment narrows the input shape — host, enum, tool name, message id pattern.
- **Do not include a timestamp or message id in the dedupKey.** Recurrence-tracking depends on the key being stable across audits.
- If a finding could collapse against an existing dedupKey (passed in `existingDedupKeys`), USE THAT KEY VERBATIM. The upsert will bump the occurrence count instead of inserting a new row.

### Dedup is `(userId, category, dedupKey, dismissed=false)` — not dedupKey alone

`upsertAdminNote` keys on the composite `(category, dedupKey)`, so the same dedupKey under _different categories_ produces parallel rows. This is intentional and tolerated — if a finding lands as `tool_misbehavior:foo:bar` in one chunk and `flow_friction:foo:bar` in another, you'll get two rows that triage independently rather than a single one that's miscategorized. **File generously.** Prefer a few duplicate-tolerated rows over missing a real issue because the category drifted. If you're confident the prior row was the same root cause and same category, reuse the exact `(category, dedupKey)` pair and the row will bump cleanly. If you're not confident, file and let the admin merge or dismiss — false positives cost a click, misses cost the bug shipping unchanged.

## Translation discipline (the user-facing chat quality check)

The system prompt's "Talking to the user — translate, don't parrot" section is the source. When auditing assistant text, flag any user-facing text that mentions:

- **Status enum codes** in caps — `CAUGHT_UP`, `SHORTLISTED`, `SCANNED`, `CLOSED`, `DELISTED`, `DEFERRED`, `APPLIED`, `RESPONDED`, `INTERVIEW_SCHEDULED`, `INTERVIEW_DEBRIEF`, `OFFERED`, `REJECTED`, `PITCHED`, `READY`, `APPLYING`, `IN_FLIGHT`, `IN_PROCESS`, `PAUSED`, `BLOCKED`, `OPEN`, `SCREENING`, `AWAITING`.
- **Reason codes** — `NOT_A_MATCH`, `LOCATION_MISMATCH`, `USER_REJECTED`, `OUTRANKED`, `WITHDRAWN`, `USER_PAUSED`, `CANNOT_SCRAPE`, `NO_OWN_BOARD`, `AUTH_WALLED`, `AMBIGUOUS_NAME`.
- **Tool names** — `search_jobs`, `propose_shortlist_auto`, `compact_chat`, `whats_next`, `set_focus`, `get_application_form`, `draft_application`, `update_jobs_status`, `update_company_status`, `log_event`, `add_to_watchlist`, `create_opportunity`, `discover_companies`, etc.
- **Mode / rung / orchestration vocab** — "walkthrough mode", "discovery mode", "profile-enhancement mode", "rung 0/1/2/3/4", "the orchestrator", "the sub-agent", "the main agent loop".
- **Memory file paths** — `profile.md`, `companies/{slug}.md`, `resume.md`, `frequent_questions.md`, `jobs/{id}.md`, `contacts/{slug}.md`.
- **Compaction / context / model framing** — "compacting", "context window", "60K tokens", "Claude", "Sonnet", "Haiku", "Fable", "Opus".
- **Internal model/entity names** — `JobInteraction`, `CompanyInteraction`, `MemoryNote`, `Opportunity` (as a noun for a row).

Each instance is its own finding with dedupKey `translation_discipline:<category>:<the_word>` (e.g. `translation_discipline:enum_leak:DEFERRED`).

User-typed messages don't count — if the user said "sub-agent" first and Hank mirrored, that's the user's vocabulary leaking in, not Hank's leak.

## Confabulated on-screen surfaces (the agent drew the screen itself)

Roles, shortlists, and "what's next" pickers are rendered by the system as widgets — Hank's chat text must never reproduce one. The failure class: after switching companies, Hank typed out a checkmarked role menu ("1. ✓ Staff Engineer …", "Which roles should you apply to?", "Tap Skip Block") with **invented** roles the system hadn't surfaced yet — confidently presenting jobs that didn't exist and didn't match the real shortlist.

The harness pre-detects this and emits a `confabulated_ui:<tier>:<id>` flag (see `detectFabricatedUiRender`):

- **`confabulated_ui:hard:*`** — Hank echoed an internal operator marker (the `<system-reminder>` wrapper). This is ALWAYS a bug; file it.
- **`confabulated_ui:fuzzy:*`** — Hank's prose is shaped like a widget (role menu, "✓ = recommends applying" legend, picker header). Verify against the turn's actual rendered widgets: if Hank's text duplicates/previews/invents what the widget shows, file it; if it's an incidental list, skip.

File as `flow_friction` (or `agent_confusion` if the listed roles are fabricated/contradict the real shortlist) with dedupKey `confabulated_ui:<failure mode>` — e.g. `confabulated_ui:role_menu_in_prose`, `confabulated_ui:invented_roles_after_switch`. Severity HIGH when the roles are fabricated (the user can't tell real from invented), MEDIUM when it's a harmless duplicate of a widget that did render.

## Data integrity invariants

Before declaring "no data findings," verify these explicit invariants against the post-window state:

1. **No mid-flight jobs at terminal companies.** A `CompanyInteraction` with status `CLOSED` or `PAUSED` should not have any `JobInteraction` rows at status `NEW`, `SCANNED`, or `SHORTLISTED`. If it does, that's a `data:orphaned_mid_flight_jobs:terminal_company` finding (HIGH) — each company is one occurrence of the same dedupKey.
2. **Focus state matches conversation state.** If the agent ended the window in the middle of a walkthrough, `ChatSession.focusedJobId` should still be set. If it ended after Advance, focus should be cleared.
3. **No pitched-but-orphaned opportunities.** An `Opportunity` row with no linked `JobInteraction` is dead weight; if the agent created one without attaching a role, flag it.
4. **shortAnswers shape compliance.** `JobInteraction.shortAnswers` should match `Json: [{question, answer}]`. Anything else (freeform blob, missing question field) is a `draft_application:persistence:freeform_blob` finding.

These are deterministic and the audit script pre-computes them — the auditor's job is to frame them as findings and pick severity.

## Cost / efficiency signals

Findings here are subtler — call them out only if the pattern is clear:

- A tool got called ≥5× in one turn that could have been collapsed (e.g. 6 `get_application_form` calls when one batch endpoint would have worked).
- Sub-agent was invoked when a deterministic tool would have done the same work cheaper (e.g. `propose_shortlist_auto` on a 2-job board — overkill).
- `compact_chat` got called when the chat was already short ("no compaction needed" result).
- Status churn: a single company flipping status ≥3 times in window.
- Cache miss patterns: `cache_create` vastly exceeds `cache_read` over a multi-turn window (suggests the static prefix isn't stable).

## What NOT to file

- "I would have phrased the reply differently" — preference, not a defect.
- "The tool returned the right answer slowly" — performance is its own track.
- "The user asked a confusing question" — user prerogative; only Hank's response shape matters.
- "The model picked a fine but not optimal job to shortlist" — judgement calls aren't findings unless they're clearly wrong against the user profile or thesis.
- "Hank used the user's own jargon back at them" — mirroring isn't a translation violation.

## Output shape

Findings must be returned via the forced `commit_chunk_findings` tool call, schema:

```ts
{
  findings: Array<{
    category:
      | "tool_misbehavior"
      | "agent_confusion"
      | "user_confusion"
      | "flow_friction"
      | "capability_request"
      | "self_improvement";
    severity: "LOW" | "MEDIUM" | "HIGH";
    summary: string; // one sentence, ≤180 chars, naming the failure
    context: string; // 3-12 lines: message ids/timestamps, verbatim quotes, root-cause hypothesis
    dedupKey: string; // per convention above
  }>;
}
```

Empty `findings` array is valid output ("nothing new since last audit"). Don't pad with low-quality findings to fill space.
