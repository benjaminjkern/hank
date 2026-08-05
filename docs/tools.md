# Agent tool patterns

Things to know before adding or modifying a tool: the flat one-file-per-tool registry, how an agent turn dispatches them, the replay/abort invariant, the structured error shape, and the two mid-turn-refresh opt-ins.

Every callable tool is one `ToolDef` in **one file** under [src/server/agent/tools/registry/](../src/server/agent/tools/registry/). Hank's live set is assembled by [`hankTools()`](../src/server/agent/hank/toolset.ts) (one import per tool).

**The registry holds every ToolDef, not just Hank's.** A handful are handed only to sub-agents and are deliberately absent from `hankTools` — currently `fetch_url`, `test_scrape`, `probe_ats`, `read_reusable_application`. They live here anyway: they're the same `ToolDef` contract, dispatched by the same loop, and a reader grepping a tool name should find one file wherever it's used. To enumerate them: every `registry/*.ts` with no matching import in `toolset.ts`. (Note `toolAffectsViewedState` derives from `hankTools`, not from the registry, so a sub-agent-only tool never appears there — correct, since nothing re-fetches the panel off a sub-agent's read.)

**Filename, const, and `name:` are one name in three casings** (AGENTS.md → "One name per concept"): `markJobApplied.ts` exports `markJobAppliedTool` whose `name` is `"mark_job_applied"`. The camelCase file and const are the camelCase of the snake_case tool name; the const suffix is always `Tool` (never `ToolDef` — that's the *type* in [tools/lib/types.ts](../src/server/agent/tools/lib/types.ts)). A mismatch (a `promoteResume.ts` that defines `attach_resume_to_profile`, a `url.ts` that defines `fetch_url`) means a reader grepping the tool name can't find its file — don't introduce one. Shared tool infra lives in the sibling [`tools/lib/`](../src/server/agent/tools/lib/) — `types.ts`, `toolError.ts`, `resolveEntityArg.ts`, and `index.ts` (which exposes only `toolAffectsViewedState`, derived from the live `hankTools` set so there's no parallel array to drift — not the registry). `tools/` itself is just `registry/` + `lib/`. **`tools/lib/` is abstract infra ONLY** — no domain-specific constant, schema, rule, or write (see the "Tool handlers are thin" section below).

## Tool handlers are thin — the logic lives in the domain layer

A tool `handle()` is the **agent I/O boundary**, nothing more. It does four things and stops:

1. Resolve the agent's slugs → ids (`resolve*BySlug`) and parse its local-time strings → `Date` (`parseEventDateTime`).
2. Call ONE domain function — in `entities/<domain>/` or `procedures/registry/`.
3. Format the agent-facing result string / shape the `toolError`.
4. Return.

Everything else — the `$transaction`, the DB writes, status computation, event→status mapping, the clear-on-transition reason nulling, cascades, slug minting — is **business logic and belongs in the domain layer**, so a second surface (a pipeline, a procedure, another tool) reuses the *exact* same behavior. The reference split is [`create_opportunities`](../src/server/agent/tools/registry/createOpportunities.ts) (thin) → [`entities/opportunities/createOpportunities.ts`](../src/server/entities/opportunities/createOpportunities.ts) (the work): the tool translates slugs + local-time and formats; the entity owns the transaction, the seed events, and the slug mint. `mark_job_applied` / `close_job` / `draft_application` follow the same shape — the handler resolves + delegates + formats.

**Read tools:** a `SELECT` + markdown formatting is presentation — fine to keep in the tool. But a genuine read-*model* — a "which statuses count as active" default ([`listCompanyJobs`](../src/server/entities/jobs/listCompanyJobs.ts)) — is domain: extract a loader (returning a status *enum*, not the human phrase) and let the tool render. When the shape is set by a SCREEN rather than the domain, that loader is a view: `view_application_questions` renders [`loadApplicationView`](../src/server/views/application.ts), the same payload the user's application page draws.

**Reuse before you write a helper.** Before adding a function, grep `entities/<domain>/` + `procedures/registry/` for one that already does the job. The write **seams** are deliberately single-implementation — a second copy silently drifts from the first:

- **Timeline event + status-cache write** — [`logJobEvents`](../src/server/entities/jobs/logJobEvents.ts) (jobs) · [`logCompanyEvent`](../src/server/entities/companies/logCompanyEvent.ts) (companies) · [`logOpportunityEvent`](../src/server/entities/opportunities/logOpportunityEvent.ts) (leads). Never `prisma.jobEvent.create` + a hand-rolled status flip at a call site — `close_job`/`defer_job`/`mark_job_applied`/`log_job_events` and the bundled/close-company batch all go through `logJobEvents`. Each costs a CONSTANT number of statements whatever the item count (read prior state → decide in JS → `createMany` + [`bulkUpdate`](../src/server/db/bulkUpdate.ts)); a caller that also has its own writes calls `planJobEvents` and runs `plan.write(tx)` inside its own transaction rather than passing a transaction in.
- **Company status write** — always [`companyStatusFields()`](../src/server/entities/companies/companyStatusFields.ts) (populates the new status's reason pair, nulls the other two statuses' four fields). Hand-nulling only some columns is the exact bug it exists to prevent (it stranded a `pauseReason`/`blockReason` on a re-blocked/re-attached row).
- **Stubs / slugs** — `createCompanyStubs`, `mint*Slug`.

If the behavior is genuinely new, add it to the domain layer and have the tool call it — don't grow the handler.

## Tool dispatch in an agent turn

Agent turns dispatch tool_use blocks **sequentially** via [`runAgentTurn`](../src/server/agent/runtime/runAgentTurn.ts). Every tool runs the same way: look the name up in `hankTools()`, `tool.parser.safeParse(input)`, then `await tool.handle(input, ctx)`. **The set is flat — there is no per-flow filter** (the old `hankTools(flow)` is gone with the flow column): Hank gets every tool every turn, including the additive CRUD set, so he can capture spontaneous information at any point. What used to be flow-scoping is now enforced inside the handler where it matters — `commit_profile` guards defensively in [`runCommitProfile()`](../src/server/procedures/registry/commitProfile.ts). There is **no streaming dispatch** — a tool that runs a long internal chain (the enrich batch behind `enrich_companies`) drains that generator inside its own `handle()` and returns one result; a simpler one (`scrape_jobs_for_company`) just `await`s a plain-async procedure.

Implications when adding a handler:

- **`ToolContext` is rebuilt per dispatch with a fresh `trace.parentToolUseId`.** Don't share mutable closure state across dispatches.
- **Tools that fan out internally** (`scrape_jobs_for_company`, the enrich batch behind `enrich_companies`) compose normally — the runner `await`s each tool's `handle()` (which awaits its own internal work) before dispatching the next tool.
- Agent turns are intentionally narrow; if one emits 5 tools per turn, the prompt is wrong (the state machine should drive most actions deterministically).
- To serialize an operation against itself, use a session-scoped lock inside the handler — don't reintroduce a worker pool.

## Tools that fan out internally

Every tool follows the simple `ToolDef<Input>` contract in [tools/types.ts](../src/server/agent/tools/lib/types.ts) — sync request, single result. There is no streaming tool variant, and a new tool should not introduce one: the drafting / scan / shortlist work that would want phase captions is driven deterministically by the walkthrough state machine, not by a Hank tool.

A tool that runs a long internal pipeline is still a plain `ToolDef` whose `handle()` **drains that pipeline's `async function*` to completion** (live progress dropped, final summary + events returned) — the enrich batch behind `enrich_companies` is the model.

The thinner shape is a tool that just resolves its slug and `await`s a plain-async **procedure**: [`scrape_jobs_for_company`](../src/server/agent/tools/registry/scrapeJobsForCompany.ts) → [`runScrapeJobsForCompany`](../src/server/procedures/registry/scrapeJobsForCompany.ts), whose scrape→persist core ([`syncCompanyBoard`](../src/server/entities/jobs/syncCompanyBoard.ts)) is the same one the walkthrough's on-entry board refresh runs — a thin tool wrapper and a pipeline call both delegating to one shared unit, the convention in [AGENTS.md](../AGENTS.md).

For multi-phase orchestrators (company enrich: URL hunt → commit → logo verify), the orchestrator is a procedure the tool wrapper calls. Key rules: spread `ctx` (`{ ...ctx, companyId }`) so `trace` and `signal` reach every sub-agent and outbound fetch; **bracket the procedure in a [trace span](../src/server/platform/trace/span.ts)** so its sub-agents nest under it in the run-tree inspector instead of flat under the tool; and **don't wrap the whole chain in a hard timeout wall** — per-sub-agent turn caps + the scrape's own timeout + the user's Stop button are the bounds. See [enrichCompanies.ts](../src/server/procedures/registry/enrichCompanies/enrichCompanies.ts).

**A phase does not stream its own captions.** Live in-flight visibility is the sub-agent `trace`, which renders in the expandable chip; the structured outcome is the procedure's RETURN VALUE. Don't add a progress-event channel a caller has to drain, and never smuggle an outcome through a formatted result string for a collector to re-parse.

## Entity params are slugs, not ids

Every LLM-facing tool param that identifies a company / job / opportunity / contact is a **slug**, not a cuid — named for the entity (`company`, `job`, `jobs`, `opportunity`, `contact`, `sourceJob`), loosened to `z.string()`, and resolved slug-**or**-id at the top of `handle` via `resolve*BySlug` from [entities/resolveBySlug.ts](../src/server/entities/resolveBySlug.ts). Result strings emit the slug too. The full convention (naming map, resolve-then-use, batch `resolveJobsBySlug`, mint-at-create with `mint*Slug`, and the deliberate list of things that stay cuids — widget payloads, the in-memory `EntryTarget`, sub-agent I/O) lives in **[docs/entity-slugs.md](entity-slugs.md)**. A param named `jobId` invites the model to invent a cuid; `job` invites the slug it was shown.

## Normalize fixable URL inputs at the parser boundary

The cheapest "better error" is no error at all. Agents routinely hand URL params a bare hostname with no scheme; `z.string().url()` rejects that generically and `detectAts()` anchors on `^https?://` anyway. Every agent-facing URL param normalizes through [`normalizeUrlInput`](../src/utils/url.ts) before validating:

```ts
url: z.string().transform(normalizeUrlInput).pipe(z.string().url()),
```

Order is load-bearing — the `.transform()` runs before `.pipe(z.string().url())`, so the validator sees the normalized form and the handler persists the canonical scheme-prefixed URL. `normalizeUrlInput` prepends `https://` only when there's no `scheme://` already; genuinely bad input still fails `.url()`. Applied at `test_scrape`, `fetch_url`, update-company `url`/`logoUrl`, and job `sourceUrl`. Use it on any new agent-supplied URL param instead of a bare `z.string().url()`.

## Replay + abort invariant

Anthropic's API rejects an assistant message containing a `tool_use` block unless the immediately-following user message contains a matching `tool_result`. If a runner crashes (or a reply is cut off — Stop, a dropped connection, or a mid-stream error) between persisting the assistant message and the tool result, replay would 400. [`loadSessionMessages`](../src/server/agent/session/) defends against this by post-processing rows **convert → coalesce → strip → repair**: pipeline UI blocks render to text, `coalesceSameRole` merges consecutive same-role messages (conversion can leave back-to-back assistant messages, also rejected), then `stripOrphanToolResults` and `repairOrphanToolUses` run **last** — the latter injects synthetic `is_error=true` tool_result blocks for orphan `tool_use`s. Coalescing never changes the user/assistant sequence, so keep it before the repair passes. Don't remove `repairOrphanToolUses` — it's the only thing between a mid-tool crash and a permanently-broken session.

The **Stop button** leans on the same machinery. The stop endpoint aborts a `runController` that [`runUserMessage`](../src/server/agent/runtime/runUserMessage.ts) threads through every Anthropic SDK call and into `ToolContext.signal` for every dispatch. It's **single-press and immediate** — no soft/hard two-tier (the old dead `softStop` flag + 5s timer are gone):

- One bodyless `POST /api/chat/stop` calls `runController.abort()` (see [`stopRegistry.ts`](../src/server/agent/runtime/stopRegistry.ts)), tearing down the in-flight model stream + the currently-running tool at once. `runAgentTurn` catches the `APIUserAbortError`, degrades to the partial that streamed (`stopped:true`), and the runner persists it via `appendAssistantMessage(..., { stoppedByUser: true })` — including any `tool_use` blocks, deliberately **without** matching `tool_result` rows. `repairOrphanToolUses` catches them on next replay. Don't synthesize per-stop `tool_result` rows; you'd duplicate the loader's recovery and create two divergent paths.
- **The same save-partial path also fires for two non-Stop cut-offs**, so `stoppedByUser` marks any interrupted reply, not just a Stop press: a transient server↔Anthropic socket drop (`isTransientStreamError` → `stopped:true`, clean end) and a genuine mid-stream fault (an API 4xx/5xx that isn't a socket drop → `errored:<err>`; the runner persists the partial, records usage, then **re-throws** so the error still surfaces via the key-modal classification). [`loadSessionMessages`](../src/server/agent/session/) injects a cause-neutral `STOPPED_REPLY_RESUME_NOTE` after a cut-off reply so Hank can offer to continue.

**When adding a handler that wraps an Anthropic SDK call, an outbound `fetch()`, or a sub-agent — forward `ctx.signal`** (`{ signal: ctx.signal }` / `runMySubAgent({ …, signal: ctx.signal })`). The helpers null-check, so pass it verbatim. Forgetting it means Stop only closes the SSE while the server keeps spending tokens. And because Stop now rips a tool **mid-flight**, a handler that does multiple writes must be abort-safe — wrap them in one `prisma.$transaction` (or make them idempotent/resumable) so a partial can't desync the audit-event log from a status cache.

## Tool errors

`ToolResult.error` is a structured `{ code, message, dedupHint? }` — build it with [`toolError(code, message, dedupHint?)`](../src/server/agent/tools/lib/toolError.ts), never a hand-written `{ content, error: true }`. Streaming tools keep a boolean `error` and use `toolErrorStreamResult(...)` instead; both bake an inert `<!--tool-error:{…}-->` marker onto `content` so audits/dashboards parse one stable token via `parseToolErrorMarker()` (the live chip strips it via `stripToolErrorMarker()`; markdown surfaces hide the HTML comment).

- **`message`** — the human-readable, LLM-facing text the agent reads.
- **`code`** — a broad bucket picked from the `ToolErrorCode` union (the authoritative set + when-to-use-each lives in [toolError.ts](../src/server/agent/tools/lib/toolError.ts) — read it before picking one, don't re-list it here). The specific "why" lives in `dedupHint`, so a debatable code is never load-bearing.
- **`dedupHint`** — the AdminNote `dedupKey` convention `<source>:<failure mode>:<input shape>` (e.g. `view_application_questions:unsupported:greenhouse`). Pick it deliberately and grep for collisions (AGENTS.md "Admin observation gotchas").

[`runAgentTurn`](../src/server/agent/runtime/runAgentTurn.ts) returns `toolError(…)` for unknown tool / parse failure / thrown handler exceptions and plumb the error into the persisted `tool_result` block as `is_error: true` (the model sees it on next-turn replay) and into the `tool_use_complete` SSE event (the chip turns red).

**What needs a `toolError`:** the operation didn't happen and the agent must not believe it did — `GATE_BLOCKED` / `INVALID_INPUT`; an identifier couldn't be resolved — `ENTITY_NOT_FOUND` / `AMBIGUOUS_INPUT` (check explicitly, don't let a raw `P2025` bubble from the dispatch wrapper); a transport failure — `UPSTREAM_FETCH_FAILED`. **What doesn't:** informational empty states the agent can act on (an empty `read_memory` note, empty `list_companies`). Litmus: if the agent would correctly proceed by reading the content, return plain `{ content }`; if it should not believe its plan changed anything, `toolError`. A system-prompt rule also tells Hank never to narrate a failed mutation as success.

**Actionable content.** The `message` should say what it tried (name the entity/operation), why it was blocked (the specific invariant), and what to do (name the resolving tool(s), and include the blocked entities' **slugs** — capped at 10–15 — so the agent doesn't have to re-fetch state). When a gate rejects multiple bad states, **name the state, not just the desired one** — bucket blocked ids by current status and emit a per-bucket fix sentence; a blanket "do tool Z" misleads when a different state needs a different tool. The live example is the open-roles gate in [caughtUpCompany.ts](../src/server/agent/tools/registry/caughtUpCompany.ts). Note there is no cross-enum reason validation to write: the status tools are one-tool-per-status, so a job reason and a company reason are never parameters of the same call. See [lifecycle.md](lifecycle.md).

## Mid-turn view refresh: `affectsViewedState` + `refresh_viewed_state`

A tool that mutates user-visible state (dashboard buckets, focused company/job/opportunity views) triggers a mid-turn refresh, or the user sees stale data until the turn's `done` event. **The default is opt-OUT** — a def that leaves `affectsViewedState` unset counts as `true`, so a forgotten flag still refreshes (a redundant refetch is cheap; stale data on screen is not).

- **Mutation tools:** do nothing — the unset default already refreshes. `toolAffectsViewedState(name)` ([tools/index.ts](../src/server/agent/tools/lib/index.ts)) reads the flag off the live `hankTools` set (defaulting unset → `true`), so a new tool is covered automatically — nothing to register.
- **Pure reads / non-visible writes opt OUT** with an explicit `affectsViewedState: false` — read-only tools (`list_*`, `read_*`, `fetch_url`, `list_job_events`), focus-only routing (which pushes its `focus` UiEvent payload inline, so a refetch is pointless), and memory-note/AdminNote/observation-channel writes. Setting `false` just skips a wasted fetch; forgetting it only costs a redundant one.
- **Side-effecting "getters" refresh correctly by default** — `view_application_questions` (lazily fetches + persists `applicationQuestions`) and `read_job_description` (auto-promotes NEW/PITCHED → SCANNED) read like reads but mutate viewed state, so leaving them unset is right. Don't reflexively mark a `get_*` tool `false` without checking the handler for writes.
- **Company set-aside tools** refresh too: `block_company` and `update_company_interaction` ([updateCompanyInteraction.ts](../src/server/agent/tools/registry/updateCompanyInteraction.ts) — corrects one company's status + reason as a pure row write, non-handoff so Hank keeps working after).

Server-side: `runAgentTurn` reads the flag via `toolAffectsViewedState(name)`, tags the `tool_use_complete` SSE event, and the client debounce-refetches `/api/dashboard` + viewed-entity payloads (~300ms trailing; the `done` handler cancels any pending debounce).

**Deterministic pipeline runners** (walkthrough state machine, watchlist enrich loop) mutate state without dispatching a tool, so they instead `yield { type: "refresh_viewed_state" }` **immediately after a persist** (not on a pre-write "Drafting…" status line). It carries no payload, isn't a content block, and the client calls the same debounced refresh. `pipeline_widget` events already refresh for free. Set `affectsViewedState: false` to skip the refetch on read-only tools, chat-text-only tools, and tools that only write `MemoryNote`/`AdminNote`/observation channels. When in doubt, leave it unset — the default refreshes, and a redundant refresh is cheap while a missing one leaves stale data on screen.

## Handoff tools stop the agent loop: `handoff`

A tool that **hands the next on-screen surface to the deterministic layer** sets `handoff: true` on its `ToolDef`. A handoff tool is an ENTRY into a sequence: `company_walkthrough` (run that company's arm — reading, seeding the shortlist board, or picking a role, whichever rung it lands on), `work_on_job` (a role → the job arm), `find_companies` (the discovery arm), `show_whats_next` (the top-level chooser), `scrape_jobs_for_company` (pull new roles → the machine scans them), and `commit_shortlist` (the one that also writes — committing the board IS entering the walkthrough's continuation, and ending the turn denies a free post-commit turn to narrate the role picker). Once one fires, the deterministic layer owns the next surface, so the runner breaks its agent loop that turn instead of running another agent turn — that extra post-handoff turn was the confabulation bug where Hank invented an on-screen role list for the just-switched company.

**Mutations are never handoff — even the ones that end a company.** `close_company` / `pause_company` / `block_company` / `caught_up_company` finish a company, but finishing is not entering, and the flag has a real cost: it ends Hank's turn, so it would cut his reply off mid-sentence and cap "pause these six" at one (which is why there was no bulk company-status tool). They instead return **`endedCompanyId`** on the `ToolResult`. Nothing in `agent/runtime/` reads it — `runAgentTurn` hands back each tool's raw result and `runChatTurn` folds them — and then `runChat` reads it twice: to run the segment wrap ([`procedures/registry/wrapCompanySegment.ts`](../src/server/procedures/registry/wrapCompanySegment.ts)) ONCE for the message no matter how many companies were closed, and to report a wrap so what's-next comes up after his reply. Use a result field rather than the flag whenever *whether* something ended is an OUTCOME: `caught_up_company` bails to a confirmation when open roles remain and ends nothing, and `handoff` is static. Note `endedCompanyId` is deliberately NOT the same signal as `wrappedUp` ("bring up what's next"), which several paths set without a company having ended. (Same reason `commit_profile` isn't a handoff tool.) Role-level `mark_job_applied` / `close_job` / `defer_job` end one row, end no company, and set neither — moving on is an explicit follow-up call (`company_walkthrough` for more roles here, `work_on_job` for a named role).

**This flag is load-bearing for the "nothing runs unless Hank hands off" invariant** ([runtime.md → The invariant](runtime.md#the-invariant-nothing-runs-unless-hank-hands-off)): after a free-text turn the walkthrough state machine advances ONLY when a `handoff: true` tool was called, so a tool that should feed the machine MUST set the flag or its continuation silently never runs. The set is derived from the flag (`HANDOFF_TOOLS` / `turnCalledHandoffTool` in [hank/toolset.ts](../src/server/agent/hank/toolset.ts) filter on `handoff === true`) — a new such tool is covered by setting the flag; don't reintroduce a name list. Leave it unset on everything else (additive CRUD, reads, record corrections like `update_company_interaction`) so those keep working in the same turn.

## `ToolContext` IS a `RunContext`

A tool dispatch is just one more place deterministic work runs for a user, so `ToolContext` is [`RunContext`](../src/server/agent/contracts/runContext.ts) (`userId` / `sessionId?` / `trace?` / `signal?` / `runId?` / `timeZone?`) plus a **required** `sessionId` — a tool only ever runs inside a chat dispatch. **This doc owns the trace plumbing; sub-agents.md points here.**

[`runAgentTurn`](../src/server/agent/runtime/runAgentTurn.ts) assembles it once per dispatch, setting `trace.parentToolUseId` to that tool's own tool_use_id so anything the handler spawns nests under its chip. `trace.onTrace` lands each push twice: as a `parentToolUseId`-tagged `LoopEvent` streamed live to the client, and into an in-memory tree persisted to `ChatMessage.traces` at the end of the loop iteration. `signal` is the run's stop/abort signal (see Replay + abort above).

**A handler forwards `ctx` verbatim — there is nothing to convert.**

```ts
const result = await runMyProcedure({ ...ctx, companyId });
```

Every field is optional on `RunContext` and the sub-agent runner null-checks, so a handler running outside the chat (scripts, cron) needs no branch. **Never hand-build `{ onTrace: …, parentToolUseId: … }` in a handler** — that's re-introducing the runner-side shape this replaced, and it's how `scrape_jobs_for_company` silently lost its whole trace subtree (its args type had no trace field, so the sub-agents it drove were invisible in the inspector even though a chip existed to nest them under).

**How traces render.** `runSubAgent` emits `trace_text` per model text block and `trace_tool_start` / `trace_tool_complete` around each **read-tool** call. Multi-stage sub-agents drop a `trace_text` separator between stages. The streaming event union carries an optional `parentToolUseId?`; when set, the client routes the event into the named parent's `children` array (recursively) instead of top level — same `applyEvent` reducer, just nested (see [ui.md → Recursive tool segments](ui.md)).

**Only real tools get tool spans.** A PROCEDURE traces as a `trace_span_start`/`trace_span_complete` pair, deliberately a different event kind — the run-tree inspector keeps the nesting level, and the chat's `convertTrace` FLATTENS spans so a procedure never renders as though Hank had called a tool. A sub-agent's **output schema** is never traced as `trace_tool_start`/`trace_tool_complete` — it is not a tool call (see [sub-agents.md](sub-agents.md)), its payload is already the parent tool's return value, and rendering it put an internal schema name on screen as though Hank had called a tool. Transform sub-agents therefore emit a plain `trace_text` caption on start and a `trace_text` on failure, and stay silent on success; `compactSummarySubAgent` (compaction) does the same and no longer announces a fabricated `write_session_summary` tool that never existed. If you add a sub-agent, do not synthesize a child tool step for its forced call.

**Traces are informational, not replayed.** The model never sees `ChatMessage.traces` — `loadSessionMessages` reads from `content`, not `traces`. Don't smuggle logic-bearing signal through a trace; if the agent needs to remember something, put it in the assistant message content or `MemoryNote`. The tree is recursive `{ steps: TraceStep[] }` keyed by root toolUseId, serialized to the `traces` JSONB column (skipped when empty) and re-attached as `Segment[]` children on load. Builder in [traceAccumulator.ts](../src/server/agent/runTree/traceAccumulator.ts).

## JSON-envelope tool results (interactive widgets)

**No tool emits a wait-for-user surface any more** — the deterministic layer owns every widget. `ToolResult.widgets` (`ToolEmittedWidget[]`) still exists and the runner still yields each as a `pipeline_widget` event, but nothing uses it — the shortlist board (a right-panel screen, not a widget) replaced the last widget-shaped shortlist surface. The mechanism below therefore describes how a widget is wired, not a live tool path — reach for the deterministic layer instead of re-adding a widget-emitting tool. Three pieces:

1. **The tool returns JSON with a discriminator** (`{ kind: "shortlist_proposal", … }`). Keep field names stable — the widget zod-parses on every render, and the same string is what the model sees on replay. Version the discriminator (`_v2`) for breaking changes.
2. **A `tryParse<Kind>` helper** next to the widget: `JSON.parse` in try/catch, zod-validate, return `null` on failure.
3. **A scan in [ChatPanel.tsx](../src/components/Chat/ChatPanel.tsx)** finds the most-recent matching tool segment and mounts the widget once above the Composer; in scrollback the same segment renders as a compact chip.

Companion rules for interactive widgets:

- **Lock-state from live DB, not the immutable tool result** — the widget GETs a state endpoint keyed by `tool_use_id` and unmounts (returns `null`) when the underlying entities leave their interactive status. Re-probe on chat activity (gate on `messages.length` increase, not array identity; mirror `locked` into a ref).
- **Commit via marker, not a custom endpoint** — the widget builds a `<!--widget-response:{kind,…}-->` marker via [`buildWidgetSubmissionMessage`](../src/components/Chat/widgets/types.ts) and calls `send(marker)`; it arrives as an ordinary user message that a widget handler ([`src/server/widgets/`](../src/server/widgets/) — parsed by `parse.ts`, dispatched by [`dispatchTopLevelSubmission`](../src/server/widgets/dispatchTopLevelSubmission.ts) or, for the walkthrough's own widgets, inside its state machine) applies deterministically before any LLM routing.
- **Own action button, not the Composer's Send** — the widget renders its own primary button; Send is never routed into a widget.
- **Mid-stream clicks queue, they don't drop** — widget buttons are not gated on `streaming`; a click during a streaming turn is captured into `chatStore.queuedSend` and auto-fires on the turn's `done` (same path handles the `ALREADY_STREAMING` refusal). Don't reintroduce a `streaming`-conditional early-return in a widget action handler.
- **System-prompt cue:** tell the agent to stop after emitting the widget so the user reaches the decision point without competing UI noise.

## Cross-references

- **Event-to-status denormalization** (`EVENT_TO_STATUS` / `OPPORTUNITY_EVENT_TO_STATUS`, and the APPLIED-is-its-own-write-path via `mark_job_applied`) → [docs/lifecycle.md](lifecycle.md).
- **Opportunity + contact tool catalog** (`create_contact`, `create_opportunities`, `create_jobs`, `update_job_interaction`, `read_application_drafts`, etc. — all simple `ToolDef`s assembled by [`hankTools`](../src/server/agent/hank/toolset.ts), ownership-scoped by `ctx.userId` with find-then-mutate) → [docs/flows.md → Inbound opportunity](flows.md).
- **Hidden tools:** the `HIDDEN_TOOLS` suppression mechanism (two in-sync sets in [streamingCore.ts](../src/server/agent/runtime/streamingCore.ts) + [session/route.ts](../src/app/api/session/route.ts)) is still wired but the sets are empty — every tool surface is currently visible. Keep it for a future admin-telemetry tool; don't delete the sets.
