# Admin surfaces

Pages under `/admin/*` and their backing APIs are for the operator/admin. They surface state otherwise only visible through Prisma Studio or the CLI — audit-recorded friction observations, deletion recommendations, and token-cost telemetry.

## Gate

All admin pages and APIs go through [`requireAdmin()`](../src/server/auth/requireAdmin.ts), which:

1. Resolves the current user via [`getCurrentUser()`](../src/server/auth/currentUser.ts) (reads the Auth.js session).
2. Calls `notFound()` (404, not 403) if `user.isAdmin` is false — the route's existence isn't advertised.
3. Returns the `User` row otherwise.

Use it directly in any new admin server component or route handler. For mutations on user-scoped models, also scope to the admin's own `userId` via `updateMany`/`deleteMany` with `{ where: { id, userId } }` (defense-in-depth against IDOR). **Company and Job are global tables** (no `userId`) — deletion APIs rely only on `requireAdmin()`.

## Pages

| Page | What it shows / does |
| ---- | -------------------- |
| [`/admin`](../src/app/admin/page.tsx) | Index — cards (Notes / Deletions / Usage / Runs / Users) with headline counts. Read-only. |
| [`/admin/notes`](../src/app/admin/notes/page.tsx) | Open + recently-dismissed `AdminNote` rows grouped by `category`, sorted severity → occurrenceCount → lastSeenAt. Dismiss (`POST /api/admin/notes/[id]/dismiss`) clears a note from the page AND resets the dedup chain. Rows are written only by the offline audit harnesses; runtime agents neither write nor read them. See [AdminNote: single write path + categories](#adminnote-single-write-path--categories). |
| [`/admin/deletions`](../src/app/admin/deletions/page.tsx) | Companies and Jobs with `deletionRecommendedAt != null`. Hard delete (cascades) or dismiss (clear flag) — four routes under [/api/admin/deletions/](../src/app/api/admin/deletions/). |
| [`/admin/usage`](../src/app/admin/usage/page.tsx) | Cost totals, bill-source split (server-key vs user-key, off `TokenUsage.billedToServer`), cache-hit rate, per-operation/model/user tables, 30-day Pacific-time daily-cost chart, top sessions. `?user=<id>` / `?session=<id>` filter every section. Read-only. See [docs/cost.md](cost.md#server-key-vs-user-key-spend). |
| [`/admin/users`](../src/app/admin/users/page.tsx) | All users with own-key status, the `canUseServerKey` toggle (server action), `isAdmin`, signup date. |
| [`/admin/runs`](../src/app/admin/runs/page.tsx) | Run-tree inspector — see [Run-tree inspector](#run-tree-inspector-adminruns) below. Read-only. |
| [`/admin/push-subscribe`](../src/app/admin/push-subscribe/page.tsx) | Per-device Web Push registration (upserts a `PushSubscription` row); lists saved devices with delete + "send test" buttons. See [AGENTS.md → Web Push gotchas](../AGENTS.md#web-push-gotchas). |

The TopBar pill ([TopBar.tsx](../src/components/Layout/TopBar.tsx)) is the only entry point — it links to `/admin` when `user.isAdmin`. If you want "N open admin items" surfaced again, do it as a count on the TopBar pill, not a second chip.

## View any user's session (`/admin/session/[sessionId]`)

The admin can load any ChatSession into the main shell at [`/admin/session/[sessionId]`](../src/app/admin/session/%5BsessionId%5D/page.tsx) — same UI, rendering the target session owner's data read-only. Read-only is enforced at three layers (server read primitive, server write guard, client gating), and the dashboard's `isAdmin` flag flows from the **viewed** user, not the caller — so an admin sees the inspected session exactly as its owner does.

**The two-rule convention for new routes:**

- **Every new GET that scopes by `userId`** must use [`resolveViewedUser(req)`](../src/server/auth/viewerScope.ts) (returns `{viewedUserId, impersonating}`; `?impersonate=<sessionId>`), not `getCurrentUser()`. Skip it and the endpoint silently returns the _admin's_ data when viewed from the session UI — the right panel renders the wrong thing with no error.
- **Every new write/streaming route** must call [`rejectImpersonatedWrite(req)`](../src/server/auth/viewerScope.ts) at the top and return the result if non-null. The UI hides write affordances in view-session mode; this server guard is what prevents a future UI bug from writing under the wrong identity.

Routes that don't scope by `userId` at all need neither. There's no automated check — the convention is the only safety net.

## Run-tree inspector (`/admin/runs`)

A read-only god-view (like `/admin/usage` — no impersonation threading) that reconstructs the full tree of an agent **run**: exactly what was passed to the model, model + params, every tool call's input/output, interim assistant content, and nested sub-agent interiors + I/O.

**A "run"** = one `runUserMessage` call, identified by a `runId` minted at its top and stamped on every row it produces. The index (`/admin/runs`, filters `?user=` / `?session=` / `?run=`) lists recent runs; the drill-in `/admin/runs/[runId]` renders the raw collapsible tree ([RunTreeView.tsx](../src/app/admin/runs/%5BrunId%5D/RunTreeView.tsx)), assembled server-side from three tables.

**What powers it (hybrid capture — most is reconstructable, the gaps are lightly instrumented):**

- **`ChatMessage`** carries the transcript; new nullable `runId` + `turnIndex` group and order a run's rows. The `traces` column holds the sub-agent interior fan-out (reads / reasoning): [`runAgentTurn`](../src/server/agent/runtime/runAgentTurn.ts) feeds a [trace accumulator](../src/server/agent/runTree/traceAccumulator.ts) and persists its snapshot. It accumulates unconditionally rather than only when a live sink is attached — on the chat path there is none, and gating on one is how the column stayed empty (same shape `buildAssistantSegments` in [/api/session](../src/app/api/session/route.ts) already renders).
- **`TokenUsage`** is the per-LLM-call spine; new nullable `runId` / `messageId` / `parentToolUseId` / `requestParams` / `systemPromptHash` record the exact model params + which assistant turn (or parent tool_use, for sub-agent calls) the call belongs to.
- **`SubAgentRun`** gains `runId` / `parentMessageId` / `parentToolUseId` so each sub-agent nests under the exact tool call that spawned it.
- **`PromptSnapshot`** dedupes the ~70KB system-prompt skeleton (`buildHankSystem` now returns `{ full, staticText, staticHash, volatile }`); the exact prompt = skeleton + the small per-call volatile pieces stored in `requestParams`.

**Zero-plumbing sub-agent linkage via AsyncLocalStorage.** Threading these ids through every sub-agent call site would touch dozens of files. Instead [`runAgentTurn`](../src/server/agent/runtime/runAgentTurn.ts) sets a [capture context](../src/server/platform/usage/captureContext.ts) (`withCaptureContext`) around each `tool.handle()` — a plain async call ALS reliably covers — and `recordUsage` / `recordSubAgentRun` read it. The walkthrough state machine wraps each generator STEP (`sm.next()`) the same way to tag the sub-agents it drives (only `runId` there; no parent tool_use). **Do not wrap a generator BODY in `withCaptureContext`** — ALS can't survive a yield.

**Degraded / legacy data.** All new columns are nullable + additive (no backfill), so pre-instrumentation runs have no `runId`. When the index is filtered by `?session=`, that session's null-`runId` messages surface as one synthetic `legacy:<sessionId>` run; the tree renders the transcript but flags that params / prompt / per-tool sub-agent linkage weren't captured (sub-agents are correlated by session + time instead).

## AdminNote: single write path + categories

**Never `prisma.adminNote.create()` directly — every write goes through [`upsertAdminNote()`](../src/server/platform/admin/adminNotes.ts).** It match-or-inserts on `(userId, category, dedupKey, dismissed=false)`: a match bumps `occurrenceCount`, updates `lastSeenAt`, replaces the summary, and ratchets `severity` up. Inlining `create` breaks dedup and spams the page. Callers: **only** the offline [session-audit](../scripts/audits/sessions/README.md) + [sub-agent runtime audit](../scripts/audits/sub-agent-runs/README.md) harnesses — the runtime self-diligence writers (`record_observation` / `request_capability` tools, sub-agent signals, anomaly flaggers, `ClientEvent` fan-out) were all removed.

The seven `ADMIN_NOTE_CATEGORIES` ([adminNotes.ts](../src/server/platform/admin/adminNotes.ts)): **`user_confusion` / `agent_confusion` / `flow_friction` / `capability_request` / `tool_misbehavior` / `self_improvement`** and **`client_error`**. The enum is unchanged; the audit harnesses classify their findings into these categories. `client_error` now has no writer at all (it was fan-out-only, and the fan-out is gone) — kept in the enum as an audit-era value.

The dedupKey convention (`<source>:<failure mode>:<input shape>`), the dismiss-resets-chain semantics, and when to add an eighth category all live canonically in [AGENTS.md → Admin observation gotchas](../AGENTS.md#admin-observation-gotchas). A new category needs entries in `ADMIN_NOTE_CATEGORIES` and `AdminNotesView`'s label/order maps (the `category` column is `String`, so no migration).

## Client → server error reporting

SSE disconnects, the `ApiKeyBlockerModal`, chat-route errors, right-panel render crashes, Stop clicks, and widget render failures all happen in the user's **browser** — none reach the agent natively. They're recorded and surfaced back into Hank's turn-start context:

```
browser hook → reportClientEvent() → POST /api/client-events → recordClientEvent() → ClientEvent row
agent turn → loadRecentClientErrors(sessionId) → <recent-client-errors> block in buildHankSystem()
```

- **Client helper** [`reportClientEvent`](../src/lib/clientEvents.ts) — fire-and-forget POST (`keepalive`, never throws); payload `{ source, severity?, summary, context? }`.
- **Endpoint** [`/api/client-events`](../src/app/api/client-events/route.ts) — `rejectImpersonatedWrite` + `getCurrentUser`, zod-validated; no active session → ack and drop.
- **Landing** [`recordClientEvent`](../src/server/platform/clientEvents/record.ts) — writes the `ClientEvent` row and **swallows its own errors** so telemetry can't break a session. (The old AdminNote fan-out here was removed — ClientEvents no longer produce AdminNotes.)

Six sources: `sse_disconnect`, `chat_error`, `modal`, `render_error`, `widget_failure`, `stop`. **All** inject into Hank's turn-start `<recent-client-errors>` block ([`loadRecentClientErrors`](../src/server/platform/clientEvents/recent.ts) — queries `ClientEvent`s after the last assistant message, so it self-clears; never throws). That turn-start block is now the only consumer — there is no longer a "problem subset" fan-out to AdminNote.

## Cascade behavior on Company / Job deletes

The Delete button on `/admin/deletions` runs `prisma.company.delete()` / `prisma.job.delete()` and relies on schema-level FK cascade (full chain + SetNull rationale in [architecture.md → Cascading deletes](architecture.md#cascading-deletes--db-for-hard-delete-explicit-for-user-scoped)). Admin-only — the agent never deletes Company / Job rows itself (see the [three-tier delete ladder](lifecycle.md)). Handlers catch `P2003` and return `{ ok: false, error }` for the UI.

## Web Push admin notifications

[`notifyAdmin(title, body)`](../src/server/platform/notifications/pushAdmin.ts) is the single choke point for "ping the admin's devices" — reuse it rather than calling `webpush.sendNotification` directly. Operational shape, VAPID-key-binding hazard, iOS-PWA requirement, and `PUBLIC_PATHS` entries live in [AGENTS.md → Web Push gotchas](../AGENTS.md#web-push-gotchas).

## Shared cost / pricing module

Anthropic pricing lives in [`src/server/platform/usage/pricing.ts`](../src/server/platform/usage/pricing.ts), shared between [`pnpm usage`](../scripts/cost/usage.ts) (CLI), [`/admin/usage`](../src/app/admin/usage/page.tsx), and [`/admin`](../src/app/admin/page.tsx) (today's-spend headline). `PRICES` matches on a substring of the model id (`opus` / `sonnet` / `haiku`) so id bumps fall through to the right tier; `costOf(row)` computes a `TokenUsage` row's dollar cost. Update `PRICES` in one place when Anthropic changes rates.

## Adding a new admin page

1. `src/app/admin/<name>/page.tsx` — server component, `await requireAdmin()` first, delegate styled-components to a `"use client"` view file.
2. Mutations → API routes under `src/app/api/admin/<name>/...`, each gated with `requireAdmin()`.
3. Add a card to [`src/app/admin/page.tsx`](../src/app/admin/page.tsx).

**Page / view split is non-negotiable:** `styled-components` needs React context (client-only), so a `styled.div` in a server component file trips Next 16's `useContext is a client-only API`. Keep `page.tsx` a server component (Prisma + `requireAdmin`, no styled-components) and put all styled-components + interactivity in a `"use client"` `SomeView.tsx`.

## User-scoped vs global mutations

Before picking a Prisma method under `/api/admin/...`: **user-scoped models** (`AdminNote`, `MemoryNote`, `JobInteraction`, `CompanyInteraction`, `Opportunity`, `Contact`, `Resume`, …) carry `userId` — constrain via `updateMany`/`deleteMany` with `{ where: { id, userId } }`. **Global models** (`Company`, `Job`) have no `userId` — `delete({ where: { id } })` with `requireAdmin()` as the only gate. Harmless in single-user v0, but building the right pattern now is cheaper than auditing later.
