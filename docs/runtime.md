# Chat runtime

Source of truth for how a user message runs: what happens before the LLM, when the deterministic layer takes over, and where each piece of behavior lives. Read this before changing turn routing, a prompt, or the sub-agent inventory.

**There is no persisted flow state and no state machine.** A message runs as a short chain of **steps**, each one a procedure that ends by naming what runs next or by leaving the user something to answer. Profile intake is a per-turn derived prompt switch, and there is no orchestrator above any of it — a Haiku router that classified intent once existed and was removed, because the layer below always had strictly more context. Don't reintroduce one: if you need routing, give Hank a handoff tool.

Two words are load-bearing and mean different things: a **procedure** is a reusable multi-step chain ([procedures/registry/](../src/server/procedures/registry/)); "flow" is now only informal English for a user-facing sequence — it names no type, column, or directory.

## The vocabulary: Entry and StepOutcome

Everything about routing is two types in [contracts/entry.ts](../src/server/contracts/entry.ts):

- **`Entry`** names a procedure to run and its arguments. Each kind is named for the procedure it enters — which, where Hank can queue it, is also his tool's name: `company_walkthrough`, `work_on_job`, `opportunity`, `find_companies`, `commit_discovery`, `show_whats_next`, and `hank` (Hank takes the next turn, optionally opening on a synthetic `nudge` and `profileGaps`).
- **`StepOutcome`** is how every step ends: `{ next?: Entry, ended?: Segment, stopped?: true }`. A `next` means "run this now"; no `next` means "the user has something to answer" and the message is over. `ended` is a **fact** about a write the step made (a company or a discovery round finished) — it never routes anything. `stopped` means the user hit Stop.

An Entry is **never persisted**. A procedure that needs the user ends the message; their answer arrives as a new message and re-enters through an Entry, and every procedure re-derives its position from the database rather than from a step number. That's what keeps a queue from outliving its message: a queue that survives into the next one is a persisted state machine by another name.

Four things produce an Entry, and nothing else does:

1. **A click** — a widget answer or a panel's "Looks good" ([widgets/answerWidget.ts](../src/server/widgets/answerWidget.ts)).
2. **Hank, through a handoff tool** — `ctx.queue(entry)`.
3. **A step that finished** — its `next`.
4. **The chat loop itself**, for an empty send (`show_whats_next`).

## High-level shape

Every user message enters through [`runUserMessage`](../src/server/agent/runtime/runUserMessage.ts), which owns **the run** — steps 1-3 below, true of any message regardless of what it says — and then hands the message to [`runChat`](../src/server/procedures/registry/chat/runChat.ts), the chat procedure, for the rest. That split is load-bearing: everything from step 4 down is a decision about companies, roles, and profiles, and `agent/runtime/` is not allowed to know what those are.

1. **API-key gate.** [`resolveLlmClient(userId, {model: HANK_MODEL})`](../src/server/platform/llm/resolveClient.ts) throws `NoDeepseekKeyError` → typed SSE `error` event → the chat client pops the blocking modal. This is the **authoritative** first-turn gate (the first-load check in [page.tsx](../src/app/page.tsx) is best-effort — it can't see the server env).
2. **Concurrency guard.** [`claimSessionForNewRun(sessionId)`](../src/server/platform/agent/stopRegistry.ts) refuses a **genuinely live** run with `{type:"error", code:"ALREADY_STREAMING"}` before persisting anything. A run that already aborted, or is older than the `maxAgeMs` it's passed (5 min, matching the chat route's `MAX_RUN_MS` cap), is **reclaimed** rather than allowed to lock the session.
3. **Register the run** so `/api/chat/stop` can find its `AbortController`, mint the `runId` stamped on every row the run produces (powers [/admin/runs](admin.md#run-tree-inspector-adminruns)), and set `deadlineAt` on the RunContext.
4. **Own the user's message** — [`openUserTurn`](../src/server/procedures/registry/chat/openUserTurn.ts), before anything that can fail.
5. **Promote due interviews** — [`flipDueInterviewsToDebrief()`](../src/server/entities/jobs/flipDueInterviews.ts), before anything reads statuses.
6. **The first step.** A click the message carries → its answer ([`answerWidget`](../src/server/widgets/answerWidget.ts)) — deterministic, no LLM. Anything typed (or panel marks sent with an empty composer) → `{kind: "hank"}`. An empty send → `{kind: "show_whats_next"}`.
7. **Run steps** through the one router, [`runEntry`](../src/server/procedures/registry/chat/runEntry.ts), until a step names no `next`. Capped at `MAX_STEPS` (8) so a hand-off cycle can't loop, and a step isn't *started* with under a minute left before `deadlineAt` — the user gets "say the word and I'll keep going" instead of a step the cap rips mid-write (a running step reads `deadlineAt` itself and bails resumably).
8. **After the last step**, file away what the message finished: if any step reported `ended`, run [`runWrapSegment`](../src/server/procedures/registry/wrapSegment.ts) (consolidate memory → compact the transcript) **once**, however many companies ended; otherwise, if the transcript since the last summary has grown past `LONG_STRETCH_CHARS`, run it with subject `long_stretch`. It runs last because it's slow (two LLM passes) and the user has nothing to wait for — a named next company shouldn't wait behind the last one's filing.

**Why the wrap-up keys off `ended`, not off "the chooser came up".** Half a dozen paths bring up the chooser with nothing having ended (a declined revive, finished profile intake, a stale pick), so they're two different things on purpose: `ended` is a fact a write reports; `next: show_whats_next` is routing. Merging them compacts on every one of those paths.

## The `hank` step

[`runHankTurns`](../src/server/procedures/registry/chat/hankTurns.ts) loops Hank turns up to `MAX_AGENT_LOOPS` (20) so a multi-tool sequence finishes in one message (`create_jobs`, read the ids off the result, then `log_job_events`). The loop ends when Hank stops calling tools **or** a turn queued an Entry — which becomes the step's `next`. One derived read picks his prompt body: `profileIntake = !(await isProfileObviouslyEnriched(userId))`, three memory slots via Postgres, no LLM. If intake was on at entry and the slots are now full (only a passing `commit_profile` causes that), the step's `next` is `show_whats_next` — finishing setup is the end of a sequence.

Under it sit two runtime helpers that know none of this: [`runHankTurn`](../src/server/agent/runtime/runHankTurn.ts) runs ONE Hank turn (resolve the key → load the transcript → stream → persist → meter) and [`runAgentTurn`](../src/server/platform/agent/runAgentTurn.ts) streams the completion and dispatches its tools. They stay domain-free by inversion: the prompt arrives as a **builder**, and what comes back is every dispatched tool's raw result plus `queued` — the one Entry a handoff tool queued, carried but never read.

## The invariant: nothing runs that wasn't named

Deterministic work runs only when something explicitly names it: a click, a handoff tool Hank called **this turn**, or a step's `next`. A quiet free-text turn — he answered, asked, ran reads or record-only writes — runs **nothing** after his reply. There is no behind-his-back re-derivation.

**Tools are dumb.** A tool does its one thing and reports back; it never decides what runs after it. It shows things through `ctx.say` — a panel move or a status line, never a widget (asking the user is a procedure's job) — and a **handoff** tool hands Hank's request to a procedure through `ctx.queue`. From there the procedure decides every hop. Three rules on the queue, enforced by `runAgentTurn`:

- **Only `handoff: true` tools may queue.** Every tool is statically one or the other.
- **One hand-off per turn.** A second `queue` call in the same turn throws `HandoffConflictError`, which reaches Hank as a `STATE_CONFLICT` tool error.
- **A handoff that fails hands nothing off.** A queue from a tool that then returns an error is dropped, so Hank reads the error and keeps going. (Detecting a handoff by tool *name* instead would end his turn on a failed one and drop the user onto the chooser.)

| Handoff tool | Queues |
| --- | --- |
| [`company_walkthrough`](../src/server/tools/registry/companyWalkthrough.ts) | `company_walkthrough` — whichever rung it lands on (scrape / prescan / scan / shortlist / role picker). The only shortlist entry. `revive: true` is the typed form of the revive widget's "yes". |
| [`work_on_job`](../src/server/tools/registry/workOnJob.ts) | `work_on_job`, for a role the user **named** — the prose counterpart to a `next_job_picker` pick. Both go through [`promoteJobForWork`](../src/server/entities/jobs/setJobAside.ts). |
| [`find_companies`](../src/server/tools/registry/findCompanies.ts) | `find_companies`, which searches and opens the discovery panel. |
| [`commit_discovery`](../src/server/tools/registry/commitDiscovery.ts) | `commit_discovery` — adds every still-checked company, records the unchecked ones. |
| [`scrape_jobs_for_company`](../src/server/tools/registry/scrapeJobsForCompany.ts) | `company_walkthrough` after the scrape, which scans + shortlists the new survivors. |
| [`show_whats_next`](../src/server/tools/registry/showWhatsNext.ts) | `show_whats_next` — it emits no widget itself, so the chooser has one renderer. |
| [`commit_shortlist`](../src/server/tools/registry/commitShortlist.ts) | `company_walkthrough` with `continuation: true`, after applying the board's stances — the continuation never re-scrapes; settling a round must not start a new one. |

**Mutations are deliberately NOT handoffs, and move nothing.** `mark_job_applied` / `close_job` / `defer_job` and the company set-asides (`close_company` / `pause_company` / `block_company` / `caught_up_company`) do their one write and stop; the set-asides report `ended: "company"` and drop the panel to the dashboard. A handoff ENDS Hank's turn — right for entering a sequence, wrong for a mutation: it would cut his reply off and cap "pause these six" at one company. Moving on is Hank's separate call: hand off to what the user named ("done with Stripe, let's do Mistral" → `close_company` then `company_walkthrough`), or `show_whats_next` if they named nothing. A set-aside never puts the chooser up on its own: a chooser on top of "let's do Mistral" overrides the direction the user just gave.

**Every widget answer has a tool.** The client hides a widget once the user types, and Hank answers the text — so anything a click can do, a tool must be able to do too, or typing "yes, bring it back" dead-ends. Each answer file in [widgets/registry/](../src/server/widgets/registry/) names its typed equivalent.

**Relay, don't hide.** The flip side: deterministic work that *does* run must not change state behind Hank's back. Two mechanisms. (1) **Compaction-summary re-injection** — `runCompactSession` truncates the transcript and writes `ChatSession.summary`; `loadSessionMessages` re-injects that summary at the head of context whenever a cutoff dropped messages. (2) **`pipeline_activity` blocks** — a Hank-**only** note channel for otherwise-silent bookkeeping (the wrap-up's consolidation + compaction, `runCommitProfile`'s compaction). Persisted as a lone block on an assistant row; the **client drops it**, while replay renders it as a system note prefixed "Between turns (automatic bookkeeping — the user did NOT see this…)".

## What's next (between things)

[`runWhatsNext`](../src/server/procedures/registry/whatsNext/index.ts) is the rung walker deciding what happens between pieces of work. Only rung 0 — the profile prerequisite — fires an LLM ([`profileEnrichmentCheckSubAgent`](../src/server/subagents/registry/profileEnrichmentCheck.ts), gated by a deterministic pre-check, so an enriched user pays one Postgres round-trip and zero LLM). Full rung semantics + option tiers: [flows.md → What's next](flows.md#whats-next--the-between-things-picker).

The `show_whats_next` entry, [`runShowWhatsNext`](../src/server/procedures/registry/whatsNext/index.ts), is the chooser's **one renderer**, reached from Hank's tool, a finished walkthrough, a declined revive, and an empty send. Rung 0 open → it hands to Hank with the gaps (`next: {kind: "hank", nudge, profileGaps}`), so he opens on the specifics; otherwise it emits the `next_company_picker` and waits. `computeWhatsNextOptions` is the options-only half.

## Hank's prompt + tools

There is one Hank and **one tool set** — no per-flow filter. Lives in [src/server/agent/hank/](../src/server/agent/hank/):

- [`system.ts`](../src/server/agent/hank/system.ts) — `buildHankSystem({profileIntake, profileGaps?, timeZone?, watchlist?, recentClientErrors?, profileContext?, panelPath?, continuing?})`. Composes a shared preamble + the **profile-intake or main body** (picked by `profileIntake`, not by a stored mode) + the switchable-watchlist block. The "What you know about the user" block from [`loadHankProfileContext`](../src/server/agent/hank/profileContext.ts) renders into **every** turn and carries the de-bias rules (judge fit on the actual thesis; never declare a location mismatch from the visible-role sample alone) — keep those in sync with the scan/shortlist sub-agent prompts. Returns `{full, staticText, staticHash, volatile}` so [/admin/runs](admin.md) can dedupe the ~70KB skeleton. There is no "current focus" block — focus is ephemeral. Hank works from the conversation, the clickable chips, and an **On the user's screen** block rendered from the right panel's URL path (sent with each message), which is what lets "draft this one" resolve without a guess.
- [`toolset.ts`](../src/server/agent/hank/toolset.ts) — `hankTools()`, one import per tool from the flat registry under [tools/registry/](../src/server/tools/registry/). Which tools may queue is the `handoff` flag on each def — there is no name list. Five tools (`fetch_url`, `test_scrape`, `probe_ats`, `test_recipe`, `read_reusable_application`) are sub-agent-only and deliberately absent here while still living in the registry.
- [`call.ts`](../src/server/agent/hank/call.ts) — the call's parameters, all three next to the prompt they apply to: `HANK_MODEL` (the one pin), `HANK_MAX_TOKENS`, and `HANK_REASONING`. Same trio a `SubAgentDef` declares.

[`runAgentTurn`](../src/server/platform/agent/runAgentTurn.ts) is the shared streaming loop: it streams a completion, dispatches `tool_use` blocks **sequentially**, shows what each tool said (`ctx.say`) once its chip completes, and returns `{content, toolResults, emittedStatusLines, queued, dispatched, stopped, errored, usage, stopReason}` for the caller to persist. **Extended thinking is on**, declared as `HANK_REASONING` in `call.ts` and applied here — the main agent is the only *unforced* agent, and thinking is incompatible only with a forced `tool_choice`, which is why every sub-agent takes an injected `analysis` scratchpad instead ([sub-agents.md](sub-agents.md)). Thinking deltas aren't streamed, so reasoning stays internal, and `normalizeThinkingForReplay` keeps persisted history API-valid.

## The state-change writes

Company / job state changes are plain `entities/` writes, split by what they do:
[`companies/setCompanyAside.ts`](../src/server/entities/companies/setCompanyAside.ts),
[`companies/resumeCompany.ts`](../src/server/entities/companies/resumeCompany.ts),
[`jobs/setJobAside.ts`](../src/server/entities/jobs/setJobAside.ts),
[`jobs/markJobApplied.ts`](../src/server/entities/jobs/markJobApplied.ts).
Each performs one coherent transaction and **returns facts** — no prose, no `UiEvent`. Hank's wrapper tools call these; deterministic code calls them directly.

They are a **mutation layer, not a step-chaining procedure**: a coherent set of WRITES belongs in `entities/`, which is why the segment wrap lives in `procedures/registry/wrapSegment.ts` and there is no `wrap` parameter. Two things the caller owns, not the write: the **panel** (`buildShowEvents` — focus is ephemeral, so a switch emits show events from the tool or the procedure) and the **wording** (see below).

| Function | What it does |
| --- | --- |
| `switchToCompany` | Bump a non-terminal company to APPLYING so rung 1 won't pull the user back to the prior one. Refuses CLOSED (terminal) and BLOCKED (needs a revive) with a reason **code**; the caller words the refusal. |
| `closeCompany({reason, note?})` | Bulk-close non-terminal jobs (`NEW`/`SCANNED`/`SHORTLISTED`) with per-row events → mark company CLOSED. `DEFERRED` and APPLIED+ untouched. |
| `blockCompany({reason, note?})` | Mark BLOCKED — a **technical** set-aside ("couldn't read the board"), NOT a fit close; revivable. Touches no jobs, since an unreadable board says nothing about a role. |
| `pauseCompany({reason, note?})` | Mark PAUSED with a structured reason. No revisit timer — paused companies never auto-resurface. |
| `caughtUpCompany({derive?})` | Mark CAUGHT_UP. `derive: true` (the deterministic wrap) computes the tail status from the job pipeline instead, so a round that ended with applications out lands `IN_FLIGHT`/`IN_PROCESS` rather than "caught up"; explicit chat callers keep the user's word. |
| `reviveCompany` | Reactivate a set-aside company + null `lastScrapedJobsAt` (forces a fresh scrape). Deliberately does **not** mass-flip closed roles back to NEW — a revive means "look again for what's new"; prior judgments stand. Run by the company walkthrough when its Entry carries `revive` (the widget's "yes", or Hank's `revive: true`). |
| `closeJob({reason, note?})` / `deferJob({reason, note?})` | Single JobInteraction → CLOSED / DEFERRED + its event. |
| `promoteJobForWork` | Revive a DEFERRED / promote a NEW or SCANNED role to SHORTLISTED so `work_on_job` can run. Idempotent; leaves APPLIED / CLOSED / interview+ rows alone (`work_on_job`'s status check hands those back to the company walkthrough). |
| `markJobApplied` | Log APPLIED, stamp `applyChannel` (RECRUITER when the row carries an `opportunityId`), recompute company engagement, and return the next SHORTLISTED role at that company. Drafts are **not** touched. Shared by the `mark_job_applied` tool and the drafting widget's submit button. |

**Narration is the caller's.** These return facts; how it reads is decided one layer up, because the two audiences differ — a tool's `content` is written for Hank, the walkthrough's `pipeline_status` for the user. The user-facing formatters are pure functions in [`companyWalkthrough/narration.ts`](../src/server/procedures/registry/companyWalkthrough/narration.ts), said via `sayStateChange` (status line first, then panel events — posting a panel event first splits the assistant bubble). A machine-driven state change must always narrate; that's what keeps a silent mutation from slipping back in.

**Company-event side effects.** These also emit a [`CompanyEvent`](../src/server/entities/companies/logCompanyEvent.ts) (the per-(user, company) timeline behind "Recent activity"): `closeCompany` → a `JOBS_CLOSED` summary + a `CLOSED` status row; the others → their status row (CAUGHT_UP only when the derived status actually lands there). Best-effort — never blocks the mutation. Batch seams elsewhere collapse the same way (one `SCRAPE_FOUND` per scrape, one `JOBS_CLOSED` per delist batch, one `SHORTLIST_RAN` per commit — the scan writes NO close event, since its skips are proposed stances, not closes), while per-role milestones dual-write a company row carrying `jobId`+`jobTitle`. Full vocabulary: [lifecycle.md → Company events](lifecycle.md).

## Widget event protocol

Widgets stream as `{type:"pipeline_widget", toolUseId, kind, payload}` — built by [`widgetEvent`](../src/server/contracts/events.ts), so a producer says one event and is done. [`recordTranscript`](../src/server/agent/session/recordTranscript.ts) writes the matching block to its assistant row before passing it on, the chat route's `say` marshals it to SSE, and client-side [`chatStore`](../src/client/chatStore.ts) `applyEvent` appends a `WidgetSegment` to that row's bubble. [`PipelineWidgetSlot`](../src/client/components/Chat/widgets/index.tsx) renders the newest such segment above the composer and dispatches on `kind` — the same lookup live and after a refresh, so there is **one** widget channel, not a transient one racing a persisted one. The kind union is single-sourced in [widgetKinds.ts](../src/shared/widgetKinds.ts); each widget is a folder under [widgets/registry/](../src/client/components/Chat/widgets/registry/) holding `def.ts` + `Widget.tsx`. A kind that's been removed can still sit in old history; the slot shows a short "older question" note for it ([RetiredWidget.tsx](../src/client/components/Chat/widgets/RetiredWidget.tsx)) instead of failing, and Hank's replay says the same.

| `kind` | Submission shape |
| --- | --- |
| `company_disambiguation` | `{resolved: Array<{companyId, chosenUrl, canonicalName, shortDescription}>}` — emitted mid-add when the URL hunter returned `ambiguous`; the answer commits the chosen boards, then asks `add_more_companies`. |
| `add_more_companies` | `{answer: "yes" \| "no", settled: number}` — emitted once an add finishes. "Find more" (`yes`) → `next: hank` with a nudge to ask what this round should look for; "Done adding" (`no`) → `next: show_whats_next`, reporting `ended: "discovery"` when `settled > 0`. |
| `confirm_revive_company` | `{companyId, answer: "yes" \| "no"}` — asked by the company walkthrough when entered on a CLOSED or BLOCKED company; yes → `company_walkthrough` with `revive`, no → `show_whats_next`. |
| `confirm_application_submit` | `{jobId}` |
| `next_company_picker` | `{choice:"company", companyId}` \| `{choice:"opportunity", opportunityId}` \| `{choice:"job", jobId}` (a DEFERRED job revives to SHORTLISTED) \| `{choice:"add_companies"}` |
| `next_job_picker` | `{companyId, choice:"pick", jobId}` \| `{companyId, choice:"caught_up"}` (DEFERRED rows auto-revive on pick) |

Answers are handled in one place, [`answerWidget`](../src/server/widgets/answerWidget.ts), one file per kind under [widgets/registry/](../src/server/widgets/registry/) — the panel commit too. Submissions become an ordinary user chat message via [`buildWidgetSubmissionMessage`](../src/client/components/Chat/widgets/types.ts) — the marker `<!--widget-response:{kind, …}-->` plus a visible label — so there's no custom endpoint. Only one widget shows at a time, and answering one retires it: `PipelineWidgetSlot` scans back from the newest message and stops at the first user row, which is the typing-dismisses-widget rule.

**Transient sibling: `refresh_viewed_state`.** A payload-free ping telling the client to refetch the dashboard + viewed entity mid-turn. Not persisted (pure stream control). Deterministic steps that write visible state without a tool — persisting a drafted cover letter, each company in a batch add — emit it right after the write. Rationale: [tools.md](tools.md#deterministic-pipeline-steps-refresh-via-refresh_viewed_state).

## Who owns a chat row

**Anything the user saw has a `ChatMessage` row behind it, and exactly one writer puts it there.** The client reconciles from the DB on every terminal `done`, so an event that streamed without being persisted is an event that erases itself a beat after it appears — and an event persisted twice is a run that repeats itself the moment it ends. Both happened, in the same codebase, because five emitters each half-owned the problem.

[`recordTranscript`](../src/server/agent/session/recordTranscript.ts) wraps the whole of `runChat` inside `runUserMessage` and writes every content event on the stream — `text`, `pipeline_status`, `pipeline_widget` — into an assistant row as it passes, upserting per event. Per event and not per group, because `/api/session` is what a reconnecting or polling client reads: a row that only lands when a long batch finishes is a batch nobody can watch.

One emitter still writes its own rows: a **Hank turn**. Its assistant row carries `thinking` / `tool_use` blocks that never reach the stream at all, so it cannot be built from stream events. It says so on the wire — `{type:"message_start", messageId}` claims a row, `{type:"message_end"}` releases it, and `recordTranscript` keeps out in between. `runAgentTurn` re-announces freely as its tool loop alternates between the assistant row and the follow-up status row its tools' lines go into (announcing an open row is a no-op); [`runHankTurn`](../src/server/agent/runtime/runHankTurn.ts) releases once, after every row is written. The status row is written AFTER the tool_result row, which is what keeps every tool_use next to its tool_result on replay.

`message_start` is also the client's grouping signal, and `recordTranscript` emits one for each row it opens. The id is **pre-minted**, so the bubble the client paints live is the row the reconcile loads back and nothing repaints. Without it the client had one bubble per send while the DB had many rows, and every run ended by visibly re-cutting itself.

So for anything new that talks to chat: **say the event and stop.** Don't write a row, don't mint an id, don't announce a boundary. Reach for `message_start` / `message_end` only if you're persisting blocks the stream can't carry — which today means Hank's turn and nothing else.

The user's own message follows the same rule from the other end: [`openUserTurn`](../src/server/procedures/registry/chat/openUserTurn.ts) is the first thing `runChat` does, ahead of every fallible step. Written any later, a failure in between deleted what the user typed off their screen — they'd be left looking at an error row for a message that no longer existed.

## Provenance: the system-note channel

`pipeline_widget` / `pipeline_status` blocks are persisted to `ChatMessage.content` on **assistant-role** rows for the UI; on replay [`loadSessionMessages`](../src/server/agent/session/) renders each to a plain-text "shown to the user" note via `renderWidgetText` (the same renderer the QA harness uses, so grounding stays in lockstep). Because those are assistant rows, keeping the note in the assistant channel let the model mistake it for its own prose and confabulate a fake on-screen menu.

So [`buildProvenanceMessage`](../src/server/agent/session/uiProvenance.ts) emits it as a real `role:"system"` message — DeepSeek, the sole runtime provider, accepts mid-array system messages (verified against the live API). **Don't revert to an assistant-authored stage direction** (the old `<ui_shown>` envelope / "[Shown to the user …]" framing); that placement is exactly what got imitated. There is no runtime sanitizer any more — moving provenance off the assistant channel removed the echo pressure `stripFabricatedUiRender` was duct-taping. The fuzzy "imitates a widget" class stays offline-reported via `detectFabricatedUiRender`, whose one HARD tripwire flags an emitted `<system-reminder>` marker (still forbidden by `# The screen is not yours to draw` in [hank/system.ts](../src/server/agent/hank/system.ts), so the tripwire guards spontaneous emission, not an echo).

A fourth block type rides the same channel: **`run_error`**, written by `runUserMessage` when a run throws. The user sees an expandable error row ([ui.md → chat message shape](ui.md#chat-message-shape)); Hank sees a provenance note saying the attempt failed, nothing after it ran, and to offer a retry in his own words. Without the row, the SSE `error` event's terminal `done` triggers the client reconcile that replaces the error away — it flashed and vanished.

Because a re-roled note can move a wait-for-user terminal off the assistant channel, `loadSessionMessages` also returns `endsAwaitingUser`, computed from the raw rows — that's how `runHankTurn` knows to stop rather than make an invalid trailing-assistant call. Full story: [AGENTS.md → The screen is not yours to draw](../AGENTS.md).

## Procedures

A **procedure** ([procedures/registry/](../src/server/procedures/registry/), one folder or file per procedure) is a reusable multi-step chain — deterministic steps plus `subagents/` calls — run as a step of the chat loop, or entered by a Hank tool. The convention is one procedure fn with thin entry points on both sides, so orchestration never lives inside a tool handler.

| Procedure | What it chains | Tool entry | Runner entry |
| --- | --- | --- | --- |
| `chat/` | The loop itself: `runChat` (the message) → `runEntry` (the one router) → each step; `runHankTurns` is the `hank` step | — | `runUserMessage` |
| `companyWalkthrough/` | The company ladder: revive → enrich (`ensureEnriched`) → board refresh (`refreshBoard`) → prescan + scan → shortlist board → role picker → caught up | `company_walkthrough`, `scrape_jobs_for_company`, `commit_shortlist` (queue it) | picker picks, revive answers, commits, submitted applications |
| `workOnJob/` | One role: `runDraftApplication` → co-write hand-off or wait-for-submit | `work_on_job` (queues it) | `next_job_picker` picks |
| `scan/` | per NEW job (`scanOneJob`): `enrichJob` → `scanJob` (→ SCANNED/CLOSED), bounded fan-out in `runScan`; `runEnrichJobBody` is the enrich-only second entry the reconsider path uses | — | company walkthrough |
| `preScan/` | metadata-only bucketing of NEW jobs, chunked | — | company walkthrough; batch add |
| `shortlist/` | rank-the-pool (`runShortlist`): `loadShortlistJobsInput` → `shortlistJobs` → `seedBoardStances` → board on screen — a fresh seed, or a merge of late-arriving pool rows into an open board; re-show only when the pool is empty. The negotiation is chat + panel edits, ended by `commit_shortlist` ([flows.md](flows.md)) | — | company walkthrough (`direction` steers a fresh ranking) |
| `reconsiderJob.ts` | revive an off-board role with a stance (enrich the body first if never read) | `update_shortlist_proposal` | board edit route |
| `draftApplication/` | `ensureApplicationForm` → `applicationDecider` → `applicationDrafting` → `critiqueAndRevise`; also flips the row SHORTLISTED → APPLYING as the pass starts. `runReviewApplication` is the second entry — the critique loop alone, for writing that changed after a pass | the drafting tools; `review_application` | `work_on_job` |
| `enrichCompanies/` | worker pool over the per-company chain (`enrichOne`: hunt `companyBasicInfo` → `commitHuntedUrl` → `runVerifyCompanyLogo`). Identity only — no scrape, no prescan, no company status. `runChecklistAdd` = create stubs → this batch | `enrich_companies` | the discovery commit, company-walkthrough step 0a |
| `scrapeJobsForCompany.ts` | gate → scrape + upsert + closure detection → prescan the delta → status | `scrape_jobs_for_company` | company-walkthrough stale-board refresh |
| `findCompanies/` | load profile + résumé + watchlist → `findCompanies` sub-agent → candidates on the discovery panel | `find_companies` (queues it) | — |
| `commitDiscovery.ts` | add the checked companies (`runChecklistAdd`), record the passes, ask add-more | `commit_discovery` (queues it) | the panel's "Looks good" |
| `whatsNext.ts` | rung-0 profile gate (`runProfileEnrichmentGate`) → the pure section loads; `runShowWhatsNext` renders it | `show_whats_next` (queues it) | finished walkthroughs, empty sends |
| `attachResumeToProfile.ts` | load attachment → `parseResume` → `saveResume` | `attach_resume_to_profile` | — |
| `consolidateSessionMemory.ts` + `compactSession.ts` | `memoryConsolidation` → memory writes; then `compactSummary` → persist summary + advance the cutoff | — | `runWrapSegment`, `runCommitProfile` |
| `wrapSegment.ts` | the two above, in order | — | `runChat`, after the last step, on `ended` or a long stretch |
| `commitProfile.ts` | consolidate → verdict gate → compact | `commit_profile` | — |

**Naming.** A procedure's folder/file and its entry export are one name — `preScan/` → `runPreScan`, `wrapSegment.ts` → `runWrapSegment` — so a folder has exactly one `run<FolderName>`. A second entry into the same procedure is named for what it does (`runChecklistAdd`).

**A procedure is a plain async function, built by one wrapper.** Every entry is [`procedure(name, run)`](../src/server/procedures/lib/procedure.ts): it declares its args as [`RunContext`](../src/server/platform/runContext.ts)` & { … }`, passes `args` straight through (`{ ...args, companyId }` — no ctx rebuilding, no converter, and a tool handler's `ctx` IS one), and the wrapper brackets it in a [trace span](../src/server/platform/runs/span.ts) so the run-tree inspector shows the procedure layer between the tool and its sub-agents. **A span is not a tool call** — the chat's trace renderer flattens spans away, so a procedure never renders as though Hank had called a tool. Spans no-op where there's no parent chip to hang in (work the chat loop drives itself). **A procedure that talks to the user takes `say`**, and a step returns a `StepOutcome` ([`Say`](../src/server/contracts/events.ts) — awaited, so narration lands in order with the procedure's own writes) and returns its outcome; there are no generator procedures and no drain-to-completion adapters. Nothing dispatches procedures by name — call sites import them by symbol.

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

Intake is not a runner and not a stored mode — it's the prompt body `runHankTurns` selects when `isProfileObviouslyEnriched` comes back false. Hank writes memory as facts emerge, probes one or two dimensions a turn, recaps in prose, then calls `commit_profile` (no args — it gates the exit) → [`runCommitProfile`](../src/server/procedures/registry/commitProfile.ts):

1. [`runConsolidateSessionMemory`](../src/server/procedures/registry/consolidateSessionMemory.ts) over the recent transcript, pushing in-chat facts into `profile.md`.
2. [`profileEnrichmentCheckSubAgent`](../src/server/subagents/registry/profileEnrichmentCheck.ts) as the verdict gate (the pre-gate short-circuits when memory is obviously full).
3. **Pass** → [`runCompactSession`](../src/server/procedures/registry/compactSession.ts) (step 1 already consolidated). Nothing is cleared — there's no column to clear; `runHankTurns` observes the slots are now full and names `show_whats_next` as its `next`.
4. **Fail** → return the `missing` list + `suggestedProbes`. The result also instructs Hank to tell the user first — in one natural sentence, framed as **his own** judgment about getting good matches — that he's almost there and what he still needs, *then* re-elicit. Never "the system/a checkpoint is holding you back": hide the mechanism, not the intent.

Consolidation is deliberately **not** inside `runCompactSession` — it has to run even when the session is too short to compact, and `runCommitProfile` needs post-write memory for the verdict gate that sits between the two.
