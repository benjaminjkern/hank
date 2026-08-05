# Session audit

Real-data counterpart to [regression/conversations/](../../regression/conversations/). Where that persona harness role-plays
hand-written personas against a live ephemeral Hank, **session-audit replays the
actual rows that user sessions wrote to prod** — `ChatMessage`, sub-agent
`traces`, `pipeline_status` blocks, `pipeline_widget` blocks — and runs an
Opus 4.8 auditor over the reconstructed visible surface plus the raw
tool I/O, per turn. **It also reconstructs the
user-visible-but-out-of-chat surface** — the full drafted cover letters /
short answers, recent-activity events, company/job notes, memory & document
files, and company/job descriptions + attributes — read-only from current DB
state, so the auditor judges against everything the user could see (right panel

- Documents view), not just the chat. See the Coverage section below and
  [driver/entitySnapshots.ts](driver/entitySnapshots.ts).

The auditor's job: catch what the live agent silently routed around, missed
translating, or fumbled across turns. Findings land as `AdminNote` rows on
`/admin/notes` — both **as the audit runs** (per-chunk `commit_chunk_findings`
calls) and **at the end** (cross-window `audit_wrap_up` synthesis).

Cursor-driven and **per-chunk crash-safe**: the cursor advances after every
chunk's findings are filed. A failed run partway through chunk N leaves
chunks 1..N-1 fully filed and resumable from the end of chunk N-1.

## Usage

```
pnpm audit:sessions                                  # resume from cursor
pnpm audit:sessions --dry-run                        # zero spend, no DB writes
pnpm audit:sessions --chunk-size 50                  # default; lower = cheaper chunks, more calls
pnpm audit:sessions --max-turns 20                   # cap (default: unlimited)
pnpm audit:sessions --model claude-sonnet-4-6        # cheaper (~3x) than default Opus 4.8
pnpm audit:sessions --since-iso 2026-06-10T00:00:00Z # override cursor
pnpm audit:sessions --user-email someone@example.com # different user
```

## Coverage — what the auditor sees per turn

Each `AuditTurn` (one user message + every assistant/tool message before the
next user message) is rendered into two sections for the auditor model:

**"What the user saw"** — reconstructed visible surface:

- Verbatim user message text (`USER` row `content` blocks)
- Hank's assistant text (`ASSISTANT` `content` `text` blocks)
- `· status lines` (`pipeline_status` blocks)
- Collapsed tool chips (top-level `tool_use` names, deduped — sub-agent calls hidden)
- **Pipeline widget render text** — every `pipeline_widget` block routed
  through `scripts/regression/conversations/driver/widgetRender.ts` so the auditor sees exactly what
  the sticky bar showed the user (title, body, button labels, per-job
  reasoning notes — all 11 widget kinds covered)
- Right-panel hint (when an entity focus changed)
- Stopped-by-user flag, error events

**"Raw correctness signal"** — backstage tool I/O:

- Every top-level tool call's `input` JSON
- Every matching `tool_result` block's text or `is_error` flag
- Orphan tool calls (no matching result — usually mid-stream interruption)
- **Sub-agent traces** — `ChatMessage.traces[toolUseId].steps[]` flattened
  recursively, so judgement-class sub-agents (shortlist, drafting, decider,
  whats_next, etc.) are fully introspectable

**"What the user could ALSO see outside chat"** — the user-visible surface that
lives in the right panel / Documents view and never appears in chat,
reconstructed from **current** DB state at audit time (read-only) and keyed off
the entities each turn's toolcalls/workflow touched
([driver/entitySnapshots.ts](driver/entitySnapshots.ts)):

- **Full drafted cover letters + short answers** — untruncated, with used-date
  - reuse flag (the chat only ever echoed a truncated copy)
- **Recent-activity events** — the per-job log + the company timeline
  (SURFACED/SCANNED filtered, exactly like the panel)
- **Company + job notes** — `companies/{slug}.md`, `jobs/{id}.md`, and inline
  `JobInteraction.notes`
- **Memory / document files** — current content of every path a `write_memory`
  touched this turn (the write action itself is already in the tool I/O; this
  is the resulting file the user sees)
- **Company + job description / attributes** — company `description`; job =
  **`enrichedSummary`** (the compact summary, not the raw JD) + location / dept
  / comp / employment type

Generated on the fly (no storage, no schema change). It mirrors the focus-panel
loaders (`getFocusedJobView` / `getFocusedCompanyView`) **minus their
`flipDueInterviewsToDebrief` write**, so the audit stays strictly read-only.
Shows _current_ state — the DB has no per-turn history, and the as-generated
draft still lives in that turn's (now un-clipped) `draft_application` tool
result. Absent for turns that touched no entity.

**Deterministic flags** — pre-computed before the model sees the turn:

- Internal-vocab leaks in assistant text (enum codes, tool names, memory
  paths, model framing, bare cuids) — same regex set the conversations
  harness's perception layer uses, minus user-echo false positives
- **Confabulated on-screen surfaces** (`confabulated_ui:<tier>:<id>`) — Hank
  typed out a role menu / shortlist / picker in prose instead of letting the
  system render it. `hard` tier =
  echoed the `<system-reminder>` operator marker (always
  a bug); `fuzzy` tier = widget-shaped prose (review against the turn's actual
  widgets). Shared detector [`detectFabricatedUiRender`](../../../src/server/agent/session/uiProvenance.ts);
  rubric entry tells the auditor how to file it.
- Widget render errors (one of the 11 renderers threw)
- Internal-vocab leaks in widget render text
- Orphan tool calls
- Tool-call errors (correlated with the auditor's silent-workaround check)

## Per-call surfaces the auditor also receives in its system prompt

- Full source of [`src/server/agent/hank/system.ts`](../../../src/server/agent/hank/system.ts)
  (Hank's rulebook — the auditor judges against this)
- [`AGENTS.md`](../../../AGENTS.md) (project conventions)
- [`audit-rubric.md`](./audit-rubric.md) (what counts as a finding, severity,
  dedupKey shape, output schema)
- A session-context block: `ChatSession` state at audit time, watchlist
  status breakdown, **orphan-mid-flight-jobs-at-terminal-companies** count
- All existing un-dismissed `AdminNote` rows for this session, so the
  auditor reuses dedupKeys instead of duplicating them

## Loop shape (chunked, not per-turn)

The static reference is cached; each call sends only its slice of turns + a
tight prior-chunk summary memo, so cost stays linear in window length.

1. Project the audit window into `AuditTurn[]` (driver/replay).
2. Group turns into chunks of size N (default 50).
3. For each chunk:
   1. Render the chunk's perceptions (full fidelity, every byte preserved
      per turn — chunking is a calling convention, not a perception lossy
      step).
   2. Prefix with the prior chunk's `forwardSummary` so the auditor doesn't
      start cold.
   3. Single forced `commit_chunk_findings` call. The schema requires both
      `findings[]` (every distinct issue in the chunk, tagged by turnIndex)
      AND `forwardSummary` (≤2500 chars: user profile signals revealed,
      recurring patterns with running dedupKey counts, open threads, state
      decisions). The forwardSummary becomes the next chunk's "what you knew
      going in."
   4. Each finding files immediately via `upsertAdminNote` — the cursor
      advances after the chunk completes (crash-safe).
4. Final `audit_wrap_up` call sees every chunk's forwardSummary plus the
   state snapshot, emits:
   - `overallAssessment` (markdown, goes to the report)
   - `wrapUpFindings[]` — cross-window AdminNotes (data integrity from the
     state snapshot, frequency patterns, cross-flow behaviors). Each filed
     via `upsertAdminNote`.

The auditor system prompt explicitly enumerates every vector it must check
per turn (tool correctness, silent workarounds, translation discipline, flow
compliance, data integrity, user satisfaction, cost/efficiency, widget UX)
and begs for thoroughness — false positives are cheap, misses are expensive.

## Artifacts

Per-audit:

- `scripts/audits/sessions/artifacts/<sessionId>.audit.jsonl` — per-chunk
  appends (findings + forwardSummary) + wrap-up. A crash mid-chunk leaves
  every prior chunk's transcript durably written.
- `scripts/audits/sessions/artifacts/<sessionId>.report.md` — markdown
  report: header + wrap-up assessment + per-chunk findings + flat list of
  every filed finding for triage

## Cursor

`scripts/audits/sessions/.session-audit-cursor.json` (gitignored):

```json
{
  "sessionId": "...",
  "lastMessageId": "...",
  "lastMessageCreatedAt": "2026-06-09T21:44:00.757Z",
  "lastAuditAt": "2026-06-10T00:00:00.000Z",
  "lastAuditFindings": 13,
  "lastAuditModel": "claude-opus-4-8",
  "userEmail": "admin@example.com"
}
```

Session-changed edge case: if the user's current most-recent session ID
differs from the cursor's sessionId, the script runs two passes — tail of
the old session, then the new session from the beginning.

## Cost

≈$10–15 for a ~230-turn window on Opus 4.8; chunked so cost stays linear (the
cached static reference + per-chunk slice, not quadratic history growth). Use
`--model claude-sonnet-4-6` to cut ~3x further at some judgment quality — fine
for routine catch-up. Session-audit is 100% auditor spend, so billing the
auditor to your Claude subscription moves the whole run off the API key — see
[../lib/GRADER_BILLING.md](../../lib/GRADER_BILLING.md).

## DB writes

- `AdminNote` upserts via the canonical [`upsertAdminNote()`](../../../src/server/platform/admin/adminNotes.ts) helper (never `prisma.adminNote.create` directly)
- `TokenUsage` rows under `operation: "session_audit"` — show up in
  `pnpm usage` so the audit's own cost is visible
- Nothing else is **written**. The per-turn out-of-chat snapshots add
  **read-only** `Job` / `Company` / `JobInteraction` / `Event` / `MemoryNote`
  queries ([driver/entitySnapshots.ts](driver/entitySnapshots.ts)) — no writes,
  and deliberately no `flipDueInterviewsToDebrief` (the one write the real focus
  loaders do).
