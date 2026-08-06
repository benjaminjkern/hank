# Chat runtime

Source of truth for how a user message runs: what happens before the LLM, when the deterministic layer takes over, and where each piece of behavior lives. Read this before changing turn routing, a prompt, or the sub-agent inventory.

**There is ONE runner and no persisted flow state.** There used to be three runners (`enrichProfile` / `walkthrough` / `default`) picked by a `ChatSession.currentFlow` column; both are gone. Profile intake is a per-turn derived prompt switch, "default" was never a flow (just Hank with a thinner prompt), and the walkthrough is a **procedure** the runner enters on an explicit trigger. There is also no orchestrator above any of it — a Haiku router that classified intent once existed and was removed, because the layer below always had strictly more context (full chat history + the switchable-companies list) and so the router drifted. Don't reintroduce one: if you need routing, give Hank a routing tool.

Two words are load-bearing and mean different things: a **procedure** is a reusable multi-step chain ([procedures/registry/](../src/server/procedures/registry/)); "flow" is now only informal English for a user-facing sequence — it names no type, column, or directory.

## High-level shape

Every user message enters through [`runUserMessage`](../src/server/agent/runtime/runUserMessage.ts), which owns **the run** — steps 1-3 below, true of any message regardless of what it says — and then hands the message itself to [`runChat`](../src/server/procedures/registry/chat/runChat.ts), the chat procedure, for steps 4-7. That split is load-bearing: everything from step 4 down is a decision about companies, roles, and profiles, and `agent/runtime/` is not allowed to know what those are (see [AGENTS.md → `agent/` splits on what a piece of the agent *is*](../AGENTS.md)).

1. **API-key gate.** [`resolveLlmClient(userId, {model: HANK_MODEL})`](../src/server/platform/llm/resolveClient.ts) throws `NoDeepseekKeyError` → typed SSE `error` event → the chat client pops the blocking modal. This is the **authoritative** first-turn gate (the first-load check in [page.tsx](../src/app/page.tsx) is best-effort — it can't see the server env).
2. **Concurrency guard.** [`claimSessionForNewRun(sessionId)`](../src/server/agent/runtime/stopRegistry.ts) refuses a **genuinely live** run with `{type:"error", code:"ALREADY_STREAMING"}` before persisting anything (the client restores the typed text into the composer). A run that already aborted, or is older than the `maxAgeMs` it's passed (5 min, matching the chat route's `MAX_RUN_MS` cap), is **reclaimed** rather than allowed to lock the session — that's what stops the "couldn't chat until a process restart" trap.
3. **Register the run** so `/api/chat/stop` can find its `AbortController`, and mint the `runId` stamped on every `ChatMessage` / `TokenUsage` / `SubAgentRun` row the call produces (powers [/admin/runs](admin.md#run-tree-inspector-adminruns)).
4. **Promote due interviews.** [`flipDueInterviewsToDebrief()`](../src/server/entities/jobs/flipDueInterviews.ts) — before any routing, so "user owes a debrief" surfaces on *this* turn.
5. **Widget-submission shortcuts (deterministic, before any LLM call)** — [`dispatchTopLevelSubmission`](../src/server/widgets/dispatchTopLevelSubmission.ts). Each is parsed off the message marker by [`widgets/parse.ts`](../src/server/widgets/parse.ts) and dispatched at the top level, because the user's click already encodes the destination. In order: `company_checklist` → [`runCommitSuggestions`](../src/server/procedures/registry/commitSuggestions.ts) (settle verdicts → [`runChecklistAdd`](../src/server/procedures/registry/enrichCompanies/runChecklistAdd.ts) → learn from the declines) and `company_disambiguation` → `runDisambiguationResolution` — both `terminal`, because both end by asking `add_more_companies` (or, mid-add, by leaving a disambiguation picker up); `add_more_companies` → `enter` on `{kind:"discovery"}` for "yes", `consumed` for "no", which is what falls through to what's next; `next_company_picker` → [`dispatchNextCompanyPicker`](../src/server/widgets/dispatchNextCompanyPicker.ts), which narrates "Picking up X." and hands its `entryTarget` to the turn below. It reports back one of four outcomes — `none` (not a submission), `terminal` (the turn ends here), `enter` (run the turn on this `entryTarget`), `consumed` (the message is spent; fall through to what's-next) — and that outcome is the only thing `runUserMessage` branches on. (Shortlist decisions don't come through widget submissions anymore: the user's board edits are panel POSTs relayed via `panel_edits` blocks, and the commit is Hank's `commit_shortlist` — see [flows.md](flows.md).)
6. **Silent entry.** No user message and no picker dispatch → [`renderWhatsNext`](../src/server/widgets/renderWhatsNext.ts) over [`runWhatsNext`](../src/server/procedures/registry/whatsNext.ts): it either reports the rung-0 profile gate is still open (the gaps thread into the turn so Hank opens on specifics rather than cold) or renders the `next_company_picker` and stops.
7. **Run the turn.** Loop [`runChatTurn`](../src/server/procedures/registry/chat/runChatTurn.ts) up to `MAX_SILENT_TRANSITIONS` (6). Each pass reports two independent signals on its `done` event — see below. `wrappedUp: false` means it's waiting on the user → stop; `runUserMessage` emits the single terminal `done` the client sees.

**Two signals on `done`, and they must not be merged.** `endedCompanyId` means *a company ended* → `runChat` drops the panel back to the dashboard and runs [`runWrapCompanySegment`](../src/server/procedures/registry/wrapCompanySegment.ts) (consolidate memory → compact the transcript), **once per message** no matter how many companies were closed. `wrappedUp` means *bring up what's next* → call `runWhatsNext` again. Half a dozen paths set `wrappedUp` with no company having ended (a declined revive, finished profile intake, a job-gone fallback, the no-target dispatch branch), so keying the wrap off `wrappedUp` would compact on all of them. The wrap lives in `runChat` and not inside the mutation for the same reason: "close these three" is one turn with three tool calls, and a wrap per mutation meant three full consolidation passes.

## `runChatTurn` — two paths

Under it sit two runtime helpers that know none of this: [`runHankTurn`](../src/server/agent/runtime/runHankTurn.ts) runs ONE Hank turn (resolve the key → load the transcript → stream → persist → meter) and [`runAgentTurn`](../src/server/agent/runtime/runAgentTurn.ts) streams the completion and dispatches its tools. Two inversions keep them domain-free: the prompt arrives as a **builder** (`runHankTurn` hands back the transcript fact `hasPriorAssistantTurn`; `runChatTurn` decides what it means), and the outcome comes back as **`dispatched`** — every tool that ran, in order, with its raw `ToolResult`. Folding that list into "the last handoff target wins, the first ended company wins" is domain policy and happens in `runChatTurn`.

First, one derived read: `profileIntake = !(await isProfileObviouslyEnriched(userId))` ([profileInventory.ts](../src/server/entities/profile/profileInventory.ts)) — three memory slots via Postgres, no LLM, cheap enough to run every turn. It picks Hank's prompt body **and** guards the silent-entry branch (a cold-start user with no message needs Hank to greet and elicit, not the state machine, which with nothing to dispatch on would yield "what's next" forever).

- **Path 1 — widget submission or silent entry.** The deterministic [walkthrough state machine](../src/server/procedures/registry/walkthrough/) drives; no agent turn. A picker-driven silent entry threads `entryTarget` in-memory; a widget submission carries its ids in the marker.
- **Path 2 — free-text chat.** Loop Hank turns up to `MAX_AGENT_LOOPS` (20) so a multi-tool sequence finishes in one message (the CRUD-then-event pattern: `create_jobs`, read the ids off the tool_result, then `log_job_events`). The loop breaks when Hank stops calling tools **or** immediately after a `handoff: true` tool.

After Path 2 the runner picks exactly one continuation:

| Condition | What happens |
| --- | --- |
| A `handoff: true` tool was called | The state machine takes the next step, entering on that tool's `entryTarget`. |
| Profile intake was on at entry and the slots are now full | Report `wrappedUp: true`. `commit_profile` isn't a handoff (its *outcome* decides whether setup is over, and `handoff` is a static flag), so completion is derived rather than declared. |
| A mutation set `endedCompanyId` | Report it + `wrappedUp: true` — the wrap and the chooser both run after Hank's reply. |
| Otherwise | Nothing. Hank's reply stands and we wait for the user. |

Output from a state-machine pass is buffered into **one** assistant `ChatMessage` at the end (live SSE is unaffected). Three reasons: a widget-only row rendered as an empty bubble; related status lines read as one thought; and one write per pass keeps the row count tight.

## The invariant: nothing runs unless Hank hands off

This is the load-bearing "no hidden functionality" rule. The state machine advances on exactly three explicit triggers — a `handoff: true` tool Hank called **this turn**, a **widget submission** (a user click), or a **silent entry** (a deterministic continuation after a pick). A quiet free-text turn — he answered a question, asked one, ran read-only or CRUD tools and went quiet — runs **nothing** after his reply.

This replaced an "always re-derive the state machine after every quiet turn, then suppress it with heuristics" model. The pure-conversation guard and side-trip detection are both **gone**; the machine simply isn't invoked. Consequence: a tool whose whole purpose is to feed the deterministic layer must be `handoff: true`, or its continuation silently never runs.

**The six handoff tools** — all entries into a sequence, never mutations:

| Tool | Hands off to |
| --- | --- |
| [`company_walkthrough`](../src/server/agent/tools/registry/companyWalkthrough.ts) | The company arm — whichever rung it lands on (scrape / prescan / scan / shortlist / role picker). Also the **only** shortlist entry, and the way to show a company's remaining roles (it retired `show_next_role`: re-entering the sequence makes earlier rungs no-op). |
| [`work_on_job`](../src/server/agent/tools/registry/workOnJob.ts) | The job arm, for a role the user **named** — the prose counterpart to a `next_job_picker` pick. Both go through [`promoteJobForWork`](../src/server/entities/jobs/setJobAside.ts) (revives a DEFERRED / promotes a NEW or SCANNED role to SHORTLISTED). |
| [`find_companies`](../src/server/agent/tools/registry/findCompanies.ts) | The discovery arm (`entryTarget: {kind:"discovery", direction}`), which emits the `company_checklist`. |
| [`scrape_jobs_for_company`](../src/server/agent/tools/registry/scrapeJobsForCompany.ts) | The machine, which then scans + shortlists the new survivors. Before the invariant this relied on a behind-Hank's-back re-derivation. |
| [`show_whats_next`](../src/server/agent/tools/registry/showWhatsNext.ts) | Nothing — it starts no work and **emits no widget**. `handoff: true` with no `entryTarget` runs the machine's no-target branch, which wraps and lets `runUserMessage` render the chooser through the same `renderWhatsNext` path a close/pause wrap uses. One renderer, so the chooser can't drift between the two ways of reaching it. |
| [`commit_shortlist`](../src/server/agent/tools/registry/commitShortlist.ts) | The walkthrough's continuation — applies the board's stances (picks → shortlist, borderline → set aside, passes → closed) and lands on the role picker. The one handoff that also **writes**, because committing the board IS entering the continuation. |

**Mutations are deliberately NOT handoffs, and shouldn't become them.** `mark_job_applied` / `close_job` / `defer_job` and the company set-asides (`close_company` / `pause_company` / `block_company` / `caught_up_company`) do their one write and stop. A handoff ENDS Hank's turn, which is right for entering a sequence and wrong for a mutation: it cuts his reply off mid-sentence and caps "pause these six" at one company. Where *whether* something ended is an outcome, use a result field (`endedCompanyId`) rather than the static flag — `caught_up_company` bails to a confirmation when open roles remain and ends nothing. Moving on afterward is a separate explicit tool call. No tool advances the surface as a hidden side effect.

**Relay, don't hide.** The flip side: deterministic work that *does* run must not change state behind Hank's back. Two mechanisms. (1) **Compaction-summary re-injection** — `runCompactSession` truncates the transcript and writes `ChatSession.summary`; `loadSessionMessages` re-injects that summary at the head of context whenever a cutoff dropped messages (previously it was written and read by nothing, so the whole pre-cutoff span silently vanished). (2) **`pipeline_activity` blocks** — a Hank-**only** note channel for otherwise-silent bookkeeping (the wrap's consolidation + compaction, `runCommitProfile`'s compaction). Persisted as a lone block on an assistant row; the **client drops it** (`buildAssistantSegments` emits no segment, and zero-segment bubbles are filtered in [/api/session](../src/app/api/session/route.ts)), while replay renders it as a system note prefixed "Between turns (automatic bookkeeping — the user did NOT see this…)".

## `runWhatsNext` (between things)

[`runWhatsNext`](../src/server/procedures/registry/whatsNext.ts) is the rung walker deciding what happens between pieces of work. Only rung 0 — the profile prerequisite — fires an LLM ([`profileEnrichmentCheckSubAgent`](../src/server/subagents/registry/profileEnrichmentCheck.ts), gated by a deterministic pre-check, so an enriched user pays one Postgres round-trip and zero LLM; the judge is then shown the two slot bodies and nothing countable — see [sub-agents.md](sub-agents.md)). Two outcomes: **report the profile gate is open** (nothing is persisted — `runChatTurn` re-derives intake from the same slots; the returned gaps just sharpen what Hank opens on), or **render the `next_company_picker`** (a pure read — the user's pick re-enters as a new message, and `dispatchNextCompanyPicker` bumps status and returns the `entryTarget`). Full rung semantics + option tiers: [flows.md → What's next](flows.md#whats-next--the-between-things-picker).

The picker has exactly one renderer — [`renderWhatsNext`](../src/server/widgets/renderWhatsNext.ts) — reached three ways: a wrap (`wrappedUp: true`), a silent entry, and `show_whats_next`. It owns both branches of the verdict (narrate the profile-gate cue and hand back the gaps, or emit + persist the widget), so the chooser can't drift between the ways of reaching it. `computeWhatsNextOptions` is the options-only half (no profile gate, no session mutation).

## Hank's prompt + tools

There is one Hank and **one tool set** — no per-flow filter. Lives in [src/server/agent/hank/](../src/server/agent/hank/):

- [`system.ts`](../src/server/agent/hank/system.ts) — `buildHankSystem({profileIntake, profileGaps?, timeZone?, switchable?, recentClientErrors?, profileContext?, continuing?})`. Composes a shared preamble + the **profile-intake or main body** (picked by `profileIntake`, not by a stored mode) + the switchable-watchlist block. The "What you know about the user" block from [`loadHankProfileContext`](../src/server/agent/hank/profileContext.ts) renders into **every** turn and carries the de-bias rules (judge fit on the actual thesis; never declare a location mismatch from the visible-role sample alone) — keep those in sync with the scan/shortlist sub-agent prompts. Returns `{full, staticText, staticHash, volatile}` so [/admin/runs](admin.md) can dedupe the ~70KB skeleton. There is no "current focus" block — focus is ephemeral; Hank works from the conversation and the clickable chips.
- [`toolset.ts`](../src/server/agent/hank/toolset.ts) — `hankTools()`, one import per tool from the flat registry under [tools/registry/](../src/server/agent/tools/registry/). `HANDOFF_TOOLS` / `turnCalledHandoffTool` are **derived** from the `handoff` flag, not a hand-kept name list. A few tools (`fetch_url`, `test_scrape`, `probe_ats`, `read_reusable_application`) are sub-agent-only and deliberately absent here while still living in the registry.
- [`call.ts`](../src/server/agent/hank/call.ts) — the call's parameters, all three next to the prompt they apply to: `HANK_MODEL` (the one pin), `HANK_MAX_TOKENS`, and `HANK_REASONING`. Same trio a `SubAgentDef` declares.

[`runAgentTurn`](../src/server/agent/runtime/runAgentTurn.ts) is the shared streaming loop: it streams a completion, dispatches `tool_use` blocks **sequentially** via `dispatchToolStreaming`, and returns `{content, toolResults, emittedWidgets, emittedStatusLines, entryTarget, endedCompanyId, stopped, errored, usage, stopReason}` for the caller to persist. **Extended thinking is on**, declared as `HANK_REASONING` in `call.ts` and applied here — the main agent is the only *unforced* agent, and thinking is incompatible only with a forced `tool_choice`, which is why every sub-agent takes an injected `analysis` scratchpad instead ([sub-agents.md](sub-agents.md)). Thinking deltas aren't streamed, so reasoning stays internal, and `normalizeThinkingForReplay` keeps persisted history API-valid.

## The state-change writes

Company / job state changes are plain `entities/` writes, split by what they do:
[`companies/setCompanyAside.ts`](../src/server/entities/companies/setCompanyAside.ts),
[`companies/resumeCompany.ts`](../src/server/entities/companies/resumeCompany.ts),
[`jobs/setJobAside.ts`](../src/server/entities/jobs/setJobAside.ts),
[`jobs/markJobApplied.ts`](../src/server/entities/jobs/markJobApplied.ts).
Each performs one coherent transaction and **returns facts** — no prose, no `UiEvent`. Hank's wrapper tools call these; deterministic code calls them directly.

They are a **mutation layer, not a step-chaining procedure**: a coherent set of WRITES belongs in `entities/`, which is why the segment wrap lives in `procedures/registry/wrapCompanySegment.ts` and there is no `wrap` parameter. Two things the caller owns, not the write: the **panel** (`buildShowEvents` — focus is ephemeral, so a switch emits show events from the tool or the arm) and the **wording** (see below).

| Function | What it does |
| --- | --- |
| `switchToCompany` | Bump a non-terminal company to APPLYING so rung 1 won't pull the user back to the prior one. Refuses CLOSED (terminal) and BLOCKED (needs a revive) with a reason **code**; the caller words the refusal. |
| `closeCompany({reason, note?})` | Bulk-close non-terminal jobs (`NEW`/`SCANNED`/`SHORTLISTED`) with per-row events → mark company CLOSED. `DEFERRED` and APPLIED+ untouched. |
| `blockCompany({reason, note?})` | Mark BLOCKED — a **technical** set-aside ("couldn't read the board"), NOT a fit close; revivable. Touches no jobs, since an unreadable board says nothing about a role. |
| `pauseCompany({reason, note?})` | Mark PAUSED with a structured reason. No revisit timer — paused companies never auto-resurface. |
| `caughtUpCompany({derive?})` | Mark CAUGHT_UP. `derive: true` (the deterministic wrap) computes the tail status from the job pipeline instead, so a round that ended with applications out lands `IN_FLIGHT`/`IN_PROCESS` rather than "caught up"; explicit chat callers keep the user's word. |
| `reviveCompany` | Reactivate a set-aside company + null `lastScrapedJobsAt` (forces a fresh scrape). Deliberately does **not** mass-flip closed roles back to NEW — a revive means "look again for what's new"; prior judgments stand. Fired by `confirm_revive_company` on "yes". |
| `closeJob({reason, note?})` / `deferJob({reason, note?})` | Single JobInteraction → CLOSED / DEFERRED + its event. |
| `promoteJobForWork` | Revive a DEFERRED / promote a NEW or SCANNED role to SHORTLISTED so the job arm can run. Idempotent; leaves APPLIED / CLOSED / interview+ rows alone (the job arm's status check self-corrects those). |
| `markJobApplied` | Log APPLIED, stamp `applyChannel` (RECRUITER when the row carries an `opportunityId`), recompute company engagement, and return the next SHORTLISTED role at that company. Drafts are **not** touched. Shared by the `mark_job_applied` tool and the drafting widget's submit button. |

**Narration is the caller's.** These return facts; how it reads is decided one layer up, because the two audiences differ — a tool's `content` is written for Hank, the walkthrough's `pipeline_status` for the user. The user-facing formatters are pure functions in [`walkthrough/narration.ts`](../src/server/procedures/registry/walkthrough/narration.ts), yielded via `yieldStateChange` (status line first, then panel events — posting a panel event first splits the assistant bubble). A machine-driven state change must always narrate; that's what keeps a silent mutation from slipping back in.

**Company-event side effects.** These also emit a [`CompanyEvent`](../src/server/entities/companies/logCompanyEvent.ts) (the per-(user, company) timeline behind "Recent activity"): `closeCompany` → a `JOBS_CLOSED` summary + a `CLOSED` status row; the others → their status row (CAUGHT_UP only when the derived status actually lands there). Best-effort — never blocks the mutation. Batch seams elsewhere collapse the same way (one `SCRAPE_FOUND` per scan, one `JOBS_CLOSED` per reason, one `SHORTLIST_RAN`), while per-role milestones dual-write a company row carrying `jobId`+`jobTitle`. Full vocabulary: [lifecycle.md → Company events](lifecycle.md).

## Widget event protocol

Widgets stream as `{type:"widget", toolUseId, kind, payload}`; `runUserMessage` marshals to SSE, and client-side [`chatStore`](../src/lib/chatStore.ts) `applyEvent` writes it to `State.currentWidget` for [`PipelineWidgetSlot`](../src/components/Chat/widgets/index.tsx) to dispatch on `kind`. The kind union is single-sourced in [widgetKinds.ts](../src/lib/widgetKinds.ts); each widget is a folder under [widgets/registry/](../src/components/Chat/widgets/registry/) holding `def.ts` + `Widget.tsx`.

| `kind` | Submission shape |
| --- | --- |
| `company_checklist` | `{picked: Array<{name, context?, url?}>, declined: Array<{name}>}` — emitted by the discovery arm; `context`/`url` ride back so the URL hunter can disambiguate. A decline is the name alone (see [flows.md](flows.md) → the checklist owns the bits). Dispatched top-level → `runChecklistAdd`. |
| `company_disambiguation` | `{resolved: Array<{companyId, chosenUrl, canonicalName, shortDescription}>}` — emitted mid-checklist-add when the URL hunter returned `ambiguous`. Dispatched top-level. |
| `add_more_companies` | `{answer: "yes" \| "no"}` — emitted once an add finishes; yes re-enters discovery, no falls through to what's next. Dispatched top-level. |
| `shortlist_scan_gate` / `shortlist_regen_gate` / `shortlist_proposal` | REPLAY-ONLY ([INCOMPLETE_MIGRATIONS.md](INCOMPLETE_MIGRATIONS.md)) — nothing emits or submits them; the shortlist board replaced the widget family. Kinds survive because persisted blocks in old sessions carry them verbatim. |
| `confirm_revive_company` | `{companyId, answer: "yes" \| "no"}` — emitted when the user names a CLOSED or BLOCKED company; yes runs `reviveCompany`, no falls back to the next-company picker. |
| `confirm_application_submit` | `{jobId}` |
| `next_company_picker` | `{choice:"company", companyId}` \| `{choice:"opportunity", opportunityId}` \| `{choice:"job", jobId}` (a DEFERRED job revives to SHORTLISTED) \| `{choice:"add_companies"}` |
| `next_job_picker` | `{companyId, choice:"pick", jobId}` \| `{companyId, choice:"caught_up"}` (DEFERRED rows auto-revive on pick) |

Submissions become an ordinary user chat message via [`buildWidgetSubmissionMessage`](../src/components/Chat/widgets/types.ts) — the marker `<!--widget-response:{kind, …}-->` plus a visible label — so there's no custom endpoint. Only one widget is active at a time; `chatStore.send()` clears `currentWidget` at the start of every send.

**Transient sibling: `refresh_viewed_state`.** A payload-free ping telling the client to refetch the dashboard + viewed entity mid-turn. Not persisted (pure stream control). Deterministic steps that write visible state without a tool — persisting a drafted cover letter, each company in a batch add — emit it right after the write. Rationale: [tools.md](tools.md#deterministic-pipeline-steps-refresh-via-refresh_viewed_state).

## Message boundaries: the live stream groups the way the DB does

One user message produces **many** assistant `ChatMessage` rows — each narrated line is its own row ([`narrateStatus`/`narrateText`](../src/server/agent/session/narrate.ts)), each Hank turn writes up to three (content+tool_use, emitted widgets, emitted status lines), and a state-machine pass flushes one for the whole pass. The client, meanwhile, gets a flat event stream. Nothing in that stream said where one row ended and the next began, so the client painted the entire run into a single bubble — and the end-of-turn `refetchSession`, which loads the rows, then visibly re-cut the conversation into its real shape and dropped anything that had streamed without being persisted.

So **every producer of an assistant row announces it**: `{type:"message_start", messageId}`, carrying the row's **pre-minted** `ChatMessage.id`, yielded before the first content event that belongs to it. `applyEvent` opens an empty bubble under that id and routes subsequent segments into it, so the reconcile finds the same ids in the same order and repaints nothing.

Three rules for anything new that persists an assistant row:

- **Mint the id first** (`newRunTreeId`), announce it, then write the row with `appendAssistantMessage({id})`. A row whose id the stream never named is a bubble that appears out of nowhere when the run ends.
- **Announce lazily where the row is conditional.** `runStateMachineAndPersist` opens its row on the first event it actually buffers — announcing at entry would leave an empty bubble that later events get misfiled into when the pass turns out to yield nothing.
- **Re-announcing an already-open row is free and expected.** A turn's tool loop alternates between the assistant row and the widget/status rows, so `runAgentTurn` re-announces (deduped) rather than tracking which group it's in.

A bare `yield {type:"pipeline_status", …}` outside the state machine's buffer is the failure this prevents: it streams, it renders, and it dies at the next reconcile, because no row was ever written for it.

## Provenance: the system-note channel

`pipeline_widget` / `pipeline_status` blocks are persisted to `ChatMessage.content` on **assistant-role** rows for the UI; on replay [`loadSessionMessages`](../src/server/agent/session/) renders each to a plain-text "shown to the user" note via `renderWidgetText` (the same renderer the QA harness uses, so grounding stays in lockstep). Because those are assistant rows, keeping the note in the assistant channel let the model mistake it for its own prose and confabulate a fake on-screen menu.

So [`buildProvenanceMessage`](../src/server/agent/session/uiProvenance.ts) emits it as a real `role:"system"` message — DeepSeek, the sole runtime provider, accepts mid-array system messages (verified against the live API). **Don't revert to an assistant-authored stage direction** (the old `<ui_shown>` envelope / "[Shown to the user …]" framing); that placement is exactly what got imitated. There is no runtime sanitizer any more — moving provenance off the assistant channel removed the echo pressure `stripFabricatedUiRender` was duct-taping. The fuzzy "imitates a widget" class stays offline-reported via `detectFabricatedUiRender`, whose one HARD tripwire flags an emitted `<system-reminder>` marker (still forbidden by `# The screen is not yours to draw` in [hank/system.ts](../src/server/agent/hank/system.ts), so the tripwire guards spontaneous emission, not an echo).

A fourth block type rides the same channel: **`run_error`**, written by `runUserMessage` when a run throws. The user sees an expandable error row ([ui.md → chat message shape](ui.md#chat-message-shape)); Hank sees a provenance note saying the attempt failed, nothing after it ran, and to offer a retry in his own words. Without the row, the SSE `error` event's terminal `done` triggers the client reconcile that replaces the error away — it flashed and vanished.

Because a re-roled note can move a wait-for-user terminal off the assistant channel, `loadSessionMessages` also returns `endsAwaitingUser`, computed from the raw rows — that's how `runChatTurn` knows to stop rather than make an invalid trailing-assistant call. Full story: [AGENTS.md → The screen is not yours to draw](../AGENTS.md).

## Procedures

A **procedure** ([procedures/registry/](../src/server/procedures/registry/), one folder or file per procedure) is a reusable multi-step chain — deterministic steps plus `subagents/` calls — invoked by **either** the runner **or** a Hank tool. The convention is one procedure fn with thin entry points on both sides, so orchestration never lives inside a tool handler.

| Procedure | What it chains | Tool entry | Runner entry |
| --- | --- | --- | --- |
| `walkthrough/` | The state machine itself, one file per piece: `stateMachine.ts` entry → `dispatchByEntryTarget` → company arm (`companyArm` + `companyEnrichStep`/`boardScrape`), job arm, discovery arm, opportunity arm; plus `handleWidgetSubmission` | — | `runChatTurn` (both paths) |
| `scan/` | per NEW job (`scanOneJob`): `enrichJob` → `scanJob` (→ SCANNED/CLOSED), bounded fan-out in `runScan`; `runEnrichJobBody` is the enrich-only second entry the reconsider path uses | — | company arm |
| `preScan/` | metadata-only bucketing of NEW jobs, chunked | — | company arm; batch add |
| `shortlist/` | seed-or-reshow (`runShortlist`): `loadShortlistJobsInput` → `shortlistJobs` → `seedBoardStances` → board on screen; the negotiation is chat + panel edits, ended by `commit_shortlist` ([flows.md](flows.md)) | — | company arm (`direction` forces a fresh seed) |
| `reconsiderJob.ts` | revive an off-board role with a stance (enrich the body first if never read) | `update_shortlist_proposal` | board edit route |
| `draftApplication/` | `ensureApplicationForm` → `applicationDecider` → `applicationDrafting` → `critiqueAndRevise` | the drafting tools | job arm |
| `enrichCompanies/` | worker pool over the per-company chain (`enrichOne`: hunt `companyBasicInfo` → `commitHuntedUrl` → `runVerifyCompanyLogo`). Identity only — no scrape, no prescan, no company status. `runChecklistAdd` = create stubs → this batch | `enrich_companies` | top-level `company_checklist` dispatch, company-arm step 0a |
| `scrapeJobsForCompany.ts` | gate → scrape + upsert + closure detection → prescan the delta → status | `scrape_jobs_for_company` | company-arm stale-board refresh |
| `findCompanies/` | load profile + résumé + watchlist → `findCompanies` sub-agent → candidates | — | discovery arm |
| `whatsNext.ts` | rung-0 profile gate (`runProfileEnrichmentGate`) → the pure section loads | — | `renderWhatsNext`, `enrich_companies` |
| `attachResumeToProfile.ts` | load attachment → `parseResume` → `saveResume` | `attach_resume_to_profile` | — |
| `consolidateSessionMemory.ts` + `compactSession.ts` | `memoryConsolidation` → memory writes; then `compactSummary` → persist summary + advance the cutoff | — | `runWrapCompanySegment`, `runCommitProfile` |
| `wrapCompanySegment.ts` | the two above, in order | — | `runChat`, on `endedCompanyId` |
| `commitProfile.ts` | consolidate → verdict gate → compact | `commit_profile` | — |

**Naming.** A procedure's folder/file and its entry export are one name — `preScan/` → `runPreScan`, `wrapCompanySegment.ts` → `runWrapCompanySegment` — so a folder has exactly one `run<FolderName>`. A second entry into the same procedure is named for what it does (`runChecklistAdd`), and a generator's drain-to-completion wrapper is `<entry>Collect`.

**A procedure is a plain function, not a def object.** Unlike tools and sub-agents there is no `ProcedureDef` and no `runProcedure`, because neither justification is present: nothing dispatches procedures by name (call sites import them by symbol) and a generic executor would own no shared work — sub-agents already meter and capture themselves, there's no untrusted input to parse, and every return shape is legitimately domain-specific. What procedures DO share is two things: they declare their args as [`RunContext`](../src/server/agent/contracts/runContext.ts)` & { … }` and pass `args` straight through (`{ ...args, companyId }` — no ctx rebuilding, no converter, and a tool handler's `ctx` IS one), and the ones reachable from a tool handler bracket themselves in a [trace span](../src/server/platform/trace/span.ts) (`withTraceSpan` for a plain async procedure, `openTraceSpan` + `finally` for a generator) so the run-tree inspector shows the procedure layer between the tool and its sub-agents. **A span is not a tool call** — the chat's trace renderer flattens spans away, so a procedure never renders as though Hank had called a tool. Spans no-op where there's no parent chip to hang in, which is why the deterministic generators driven by `runChatTurn` deliberately don't open one.

## Sub-agent inventory

Every sub-agent is a [`SubAgentDef`](../src/server/subagents/lib/types.ts) run by the one entry point [`runSubAgent(def, input, ctx)`](../src/server/subagents/lib/runSubAgent.ts): declaring `readTools` (+ raising `maxTurns`, default 1) gives a read-tool loop, declaring `outputSchema` gives a structured payload, declaring neither gives a prose one-shot. See [sub-agents.md](sub-agents.md) for the transform-vs-judgement classification — a prompt-design call, not two mechanisms.

**DeepSeek runs every one of these except the two vision calls**, which name a Claude model because DeepSeek rejects image blocks. The model lives at the call site and nothing may substitute it.

| Sub-agent | Model | Called by | Role |
| --- | --- | --- | --- |
| `profileEnrichmentCheckSubAgent` | `deepseek-v4-flash` | `runWhatsNext` rung 0 + `runCommitProfile` | Verdict gate: profile complete enough to leave? |
| `preScanJobBatchSubAgent` | `deepseek-v4-flash` | `runPreScan` | Metadata-only NEW-job bucketing, per chunk |
| `enrichJobSubAgent` | `deepseek-v4-pro` | `runScan` | Body → terse summary + scalars; cached on `Job` |
| `scanJobSubAgent` | `deepseek-v4-flash` | `runScan` | Summary + thesis → SCANNED / CLOSED (per-user) |
| `shortlistJobsSubAgent` | `deepseek-v4-flash` | `shortlist/` | Proposes a board stance (pick/borderline/pass) + reason per pool role |
| `applicationDeciderSubAgent` | `deepseek-v4-flash` | `draftApplication/` (once per job) | Per-item verdict `draft`/`skip`/`ask_user`; cached on `draftDecision` |
| `applicationDraftingSubAgent` | `deepseek-v4-flash` | `draftApplication/` | Draft cover letter / short answer for one `draft`-verdict item |
| `applicationCriticSubAgent` | `deepseek-v4-pro` | `draftApplication/critiqueAndRevise` | Post-draft recruiter-lens review. See [flows.md](flows.md#post-draft-review-critique-and-revise-loop) |
| `companyBasicInfoSubAgent` | `deepseek-v4-flash` | `enrichCompanies/` | Find canonical careers URL + name + description |
| `findCompaniesSubAgent` | `deepseek-v4-flash` | `find_companies` | Grow-the-watchlist candidates from thesis + resume + watchlist signal + optional `direction` |
| `memoryConsolidationSubAgent` | `deepseek-v4-pro` | `runConsolidateSessionMemory` | Push transcript facts into memory paths (returns writes; the caller applies them) |
| `compactSummarySubAgent` | `deepseek-v4-flash` | `runCompactSession` | Condense the about-to-be-truncated slice into the running summary |
| `logoVerifierSubAgent` | `claude-haiku-4-5` | `runVerifyCompanyLogo` | **Vision** — is this logo actually this company's? |
| `parseResumeSubAgent` | `claude-sonnet-4-6` | `runAttachResumeToProfile`, the resume upload route | **Vision** — parse an uploaded resume |

## Profile intake + `runCommitProfile`

Intake is not a runner and not a stored mode — it's the prompt body `runChatTurn` selects when `isProfileObviouslyEnriched` comes back false. Hank writes memory as facts emerge, probes one or two dimensions a turn, recaps in prose, then calls `commit_profile` (no args — it gates the exit) → [`runCommitProfile`](../src/server/procedures/registry/commitProfile.ts):

1. [`runConsolidateSessionMemory`](../src/server/procedures/registry/consolidateSessionMemory.ts) over the recent transcript, pushing in-chat facts into `profile.md`.
2. [`profileEnrichmentCheckSubAgent`](../src/server/subagents/registry/profileEnrichmentCheck.ts) as the verdict gate (the pre-gate short-circuits when memory is obviously full).
3. **Pass** → [`runCompactSession`](../src/server/procedures/registry/compactSession.ts) (step 1 already consolidated). Nothing is cleared — there's no column to clear; `runChatTurn` observes the slots are now full and reports `wrappedUp: true`, so `runChat` fires `renderWhatsNext`.
4. **Fail** → return the `missing` list + `suggestedProbes`. The result also instructs Hank to tell the user first — in one natural sentence, framed as **his own** judgment about getting good matches — that he's almost there and what he still needs, *then* re-elicit. Never "the system/a checkpoint is holding you back": hide the mechanism, not the intent.

Consolidation is deliberately **not** inside `runCompactSession` — it has to run even when the session is too short to compact, and `runCommitProfile` needs post-write memory for the verdict gate that sits between the two.
