# Sub-agents

A sub-agent is an isolated LLM call with focused context whose output lands as a compact structured result — in chat, in a widget payload, or in memory. It runs _outside_ the main conversation, so its intermediate reasoning never enters main history; only the final result crosses back.

## A sub-agent is a declaration

**A sub-agent is a [`SubAgentDef`](../src/server/subagents/lib/types.ts) object — the same shape story as `ToolDef`.** One file in **[src/server/subagents/registry/](../src/server/subagents/registry/)** exports one def describing the call; the only thing that executes it is [`runSubAgent(def, input, ctx)`](../src/server/subagents/lib/runSubAgent.ts). Nothing is named `run<SubAgent>` — the def is the noun, the runner is the verb.

```ts
export const scanJobSubAgent: SubAgentDef<ScanJobInput, CommitMatchInput, ScanJobVerdict> = {
  name: "scan_job",                // = the TokenUsage.operation key (typed, so a typo won't compile)
  model: MODEL,                    // declared here next to the prompt, honored verbatim
  maxTokens: MAX_TOKENS,
  reasoning: { mode: "scratchpad", guidance: "Walk the gates in order…" },
  system: buildSystemPrompt,
  userContent: buildUserContent,   // (input) => string | ContentBlockParam[] — PURE + SYNCHRONOUS
  outputSchema: COMMIT_MATCH_SCHEMA,
  caption: (input) => `Checking "${input.role.title}" against your thesis…`,
  parse: decodeVerdict,            // raw emission → the domain shape callers want
};

// at the call site — `args` IS the context, so nothing is rebuilt:
const match = await runSubAgent(scanJobSubAgent, input, args);
if (!match.ok) return { kind: "error" };
match.output; // ScanJobVerdict
```

**Two arguments, and the split between them is the whole convention.** `input` is the sub-agent's own domain input. `ctx` is a [`RunContext`](../src/server/agent/contracts/runContext.ts) — `userId`, `sessionId?`, `trace?`, `signal?`, `runId?`, `timeZone?` — carrying the ambient params ONCE instead of every entry point re-declaring and forwarding them, and nothing else: everything about the SHAPE of the call is on the def. It's a **structural** type, so every caller already holds one and passes it straight through: a procedure declares `RunContext & { … }` and hands over its own `args`; a tool handler hands over `ctx`, because [`ToolContext` IS a `RunContext`](tools.md). There is no adapter and no runner-side variant to convert from.

**Every sub-agent returns the same [`SubAgentResult<T>`](../src/server/subagents/lib/types.ts)** — `{ok:true, output, turns}` or `{ok:false, error, status?, turns}`, where `output` is the def's `parse` result (or the raw payload / prose text when it declares none). There are no bespoke per-sub-agent result unions; `status` carries the Anthropic HTTP status so a fan-out can tell a 429 wall from a one-item failure.

**One name in three casings** — `scanJob.ts` → `scanJobSubAgent` → `"scan_job"` — exactly the rule tools follow, `SubAgent` where a tool takes `Tool` (AGENTS.md → "One name per concept"). The lib beside `registry/` is split the same way `agent/tools/lib/` is: `types.ts` (the contract), `runSubAgent.ts` (the machinery), `readTools.ts`, `subAgentRun.ts` (the capture). So `subagents/` holds nothing but `registry/` + `lib/`.

There's no maintained registry table here — the live set drifts too fast for prose to stay honest. **The current sub-agents are the `SubAgentDef` exports under `subagents/registry/` — `grep -rn "SubAgentDef<" src/server/subagents/registry/` enumerates them.** A few illustrative ones, to anchor the two classes:

- **transform** — `parseResumeSubAgent` ([subagents/parseResume.ts](../src/server/subagents/registry/parseResume.ts), vision: PDF → structured), `enrichJobSubAgent` ([subagents/enrichJob.ts](../src/server/subagents/registry/enrichJob.ts), one job body → summary + scalars), `scanJobSubAgent` ([subagents/scanJob.ts](../src/server/subagents/registry/scanJob.ts), enriched summary + thesis → skip/match), `shortlistJobsSubAgent` ([subagents/shortlistJobs.ts](../src/server/subagents/registry/shortlistJobs.ts), SCANNED survivors → ranked per-job verdicts — see "A class is a choice you can revisit" below).
- **judgement** — `companyBasicInfoSubAgent` ([subagents/companyBasicInfo.ts](../src/server/subagents/registry/companyBasicInfo.ts), name → verified careers URL via web_search), `preScanJobBatchSubAgent` ([subagents/preScanJobBatch.ts](../src/server/subagents/registry/preScanJobBatch.ts), chunked bulk-skip buckets), `boardRecipeSubAgent` ([subagents/boardRecipe.ts](../src/server/subagents/registry/boardRecipe.ts), a page's structural digest → a declarative read-plan for a board no wired provider recognizes; verifies its own work with the `test_recipe` tool and **never emits a posting** — see [docs/ats-scrapers.md → Learned boards](ats-scrapers.md)).

## A sub-agent file holds LLM I/O and nothing else

**The only thing in a registry file is what it takes to prepare the input to one LLM call and parse the output back.** Concretely, a sub-agent owns its prompt, its `const MODEL`, its output schema(s), the rendering of its input into text (`userContent`), and the parsing/validation of what comes back (`parse`). It does **not** own: DB reads, DB writes, memory writes, gates that decide whether the call happens at all, or product rules applied to the result afterwards. `scanJob.ts` is the reference — "Reads nothing and writes nothing," so the whole file is prompt and parsing.

**The def shape makes this structural rather than aspirational: `userContent` is pure and synchronous, so a def CAN'T do I/O.** That's what pushed the logo verifier's image fetch out to [`verifyCompanyLogo.ts`](../src/server/procedures/registry/verifyCompanyLogo.ts) (which also owns "the image wouldn't load → uncertain, don't spend the vision call") and the consolidator's memory-inventory read out to [`runConsolidateSessionMemory`](../src/server/procedures/registry/consolidateSessionMemory.ts). `parse` is synchronous for the same reason — the anti-shrink veto it used to do needed to read what was on disk, so it went to the caller that performs the writes.

**Failure policy is the caller's.** `parse` may THROW to reject a structurally-wrong emission (a `found` outcome missing its URL — `runSubAgent` turns that into an ordinary `{ok:false}`), but what to do when a run FAILS is a product decision the def doesn't get to make: an unparseable résumé throws at the route, a failed logo verify degrades to `uncertain`, a failed enrichment verdict conservatively routes into profile enrichment. Each lives at its call site, where the alternative is visible.

The enforcement is mechanical and worth keeping that way: **nothing under `subagents/registry/` may import `prisma`, `writeMemory`/`appendMemory`, or hold a `dryRun` flag.** Grep is the check.

```
grep -rn "db/prisma\|dryRun\|writeMemory\|appendMemory" src/server/subagents/registry/   # must be empty
```

Each of those three is a specific failure:

- **A DB read inside the sub-agent** means its context is invisible from the call site, its fixtures have to fight the loader for control, and two callers can't front-load different context. Take an input object; let the caller build it — `loadShortlistJobsInput.ts`, `loadApplicationDraftingContext.ts`, `loadApplicationCriticInput.ts`, `profileInventory.ts` are the pattern. For the critic in particular, the input object IS the specification of what the "fresh reader" knows; that's only checkable because it's an argument.
- **A write inside the sub-agent** breaks "don't give sub-agents write tools" from the other direction — the loop is clean but the wrapper writes anyway. Return the proposed write; the caller applies it (`memoryConsolidationSubAgent` returns `writes[]` → `runConsolidateSessionMemory` performs them; `logoVerifierSubAgent` returns a verdict → `applyLogoVerdict` persists it).
- **A `dryRun`/`auditContext` flag** is a harness affordance leaking into prod: it puts a branch nothing in production ever takes on the hot path, and it lets the fixture and the real call diverge silently. Once the sub-agent takes its context as an argument, a fixture is just a different argument, and there's nothing to dry-run because there's nothing to write. **The same applies to an INPUT field that exists for the harness** (`inlinePastDrafts`, which inlined past cover letters and dropped the read tools when a fixture was driving): it reads as a legitimate property of the input, but a fixture that changes the prompt or the toolset grades a call production never makes — which is the one thing an audit must not do. When a fixture's synthetic subject has no rows for a read tool to find, hand the runner a **tool double** instead (`toolDoubles`, see below): the def, the prompt, and the tool schema stay identical, and only the store behind the tool is the fixture's.

The deterministic gate is the subtle one. A pre-gate that short-circuits the LLM ("the profile is obviously enriched, skip the call") belongs with the read it's made from, not inside the thing it's deciding whether to run: `isProfileEnrichedByLength` is a rule over the same slots `loadProfileEnrichmentCheckInput` loaded, and `runProfileEnrichmentGate` only reaches `profileEnrichmentCheckSubAgent` when it comes back false — one read, no LLM call on the obvious case. Same for `decideApplicationForm`, which pre-skips structured form fields and calls the decider only if something's left.

**The same boundary decides what the sub-agent is even shown.** Anything countable — a slot's length, whether a file was uploaded, how many notes exist — is a deterministic question, so it's answered by the loader and never rendered into the prompt: [`profileInventory.ts`](../src/server/entities/profile/profileInventory.ts) hands the enrichment judge the two slot bodies **verbatim and nothing else**, because "is this thesis specific enough to match jobs against?" is the only part of that gate an LLM does better than a `length >=` check. Showing a judge a char count invites it to launder a threshold as judgement — two systems answering the same question, one of them worse and non-deterministic. Keep the countable half in SQL and let the prompt ask only what a reader has to read the text to answer.

## Where the input stops being data and starts being a prompt

"No I/O in the def" says what the caller MUST keep. This says what it must **hand over**, which is the other half and was the drifting one: the same concept used to arrive at different levels of doneness in different defs — role attributes as a structured `RoleAttrs`, but the résumé as a pre-rendered string, sibling outcomes as pre-written recruiter prose, and the transcript pre-serialized.

**The caller owns everything from `userId` → data. The def owns everything from data → prompt text.** The seam is the last thing that needs I/O. Three tests, in order:

1. **Does producing it require I/O?** → caller. Always; this is the existing rule.
2. **Does its result flow anywhere other than the prompt?** → caller. It's domain logic that happens to also feed a prompt, and moving it would split its one output across two owners.
3. **Otherwise** → def.

So `applicationCritic` takes a sibling's `status` + `closeReason` and renders "we passed on them for this one" in `userContent`. `shortlistJobs` takes `enrichedSummary` + `rawContent` and picks between them. `compactSummary` and `memoryConsolidation` take `StoredMessage[]` and call `serializeTranscript`.

Test 2 is what keeps `decideApplicationForm`'s form partition on the caller's side: the fields it removes get a **final persisted verdict**, not just a smaller prompt — and when it removes everything there's no LLM call to make. Same for `capShortlistPicks`, which acts on the output.

**"Rendering lives in the def" means CALLED FROM `userContent`, not DEFINED in the registry file.** The renderers stay in `entities/` in one copy — [`roleAttrs.ts`](../src/server/entities/jobs/roleAttrs.ts), [`pastDrafts.ts`](../src/server/entities/jobs/pastDrafts.ts), [`attributePairs.ts`](../src/server/entities/jobs/attributePairs.ts) — and the three defs that show a past-application catalog import the same function rather than growing three copies of it.

What this bought, concretely: a harness that pre-renders an input prod renders differently grades a prompt production never sent. Once the def does the rendering, a fixture can't get it wrong — it passes the same row the loader would. (The résumé is the exception that proves it: every prompt now takes the whole `resume.md` background verbatim, so there is no rendering left to get wrong.)

### One loader per sub-agent, named for it

Two shapes, and the difference is real rather than cosmetic:

- **`load<SubAgent>Input`** — returns exactly one def's `TInput`, for a 1:1 call. `loadShortlistJobsInput`, `loadApplicationCriticInput`, `loadApplicationDeciderInput`, `loadFindCompaniesInput`, `loadMemoryConsolidationInput` — each in its sub-agent's procedure folder. (`loadApplicationDraftingContext` returns the `context` half of its input; the task half comes from the caller's args, not from I/O.)
- **`load<Procedure>Context`** — returns context SHARED across a fan-out of N sub-agent calls, with the per-call input assembled in the procedure. `loadPreScanContext` (chunks), `loadScanContext` (per-job).

Home follows the normal rule: inside the procedure's folder when one procedure calls it, `entities/` when it's shared. A sub-agent whose input needs no I/O at all (`companyBasicInfo`, `logoVerifier`, `parseResume`) gets no loader — there'd be nothing in it.

**A harness never hand-builds a field the loader computes.** It either calls the loader against seeded rows, or supplies the loader's own inputs. With rendering in the def that's nearly free: what's left in a `TInput` is raw data a fixture can just state.

**`scrapeUrl` is NOT a sub-agent.** It's a deterministic ATS fetch — a single HTTPS call to a recognized ATS's JSON API, no LLM ([scrape/index.ts](../src/server/scrape/index.ts)). The old generic-HTML LLM fallback is gone; non-ATS URLs fail with an actionable error. It still accepts a `trace` arg and emits a one-line "ATS scrape: …" trace, but there's no inner LLM to surface.

Every sub-agent runs through the one entry point, [`runSubAgent`](../src/server/subagents/lib/runSubAgent.ts) — it absorbs the API-key check, client setup, trace span, per-turn usage tracking, truncation detection, abort propagation, and the `SubAgentRun` capture. **A caller never resolves a client, names a model, or calls `recordUsage`/`recordSubAgentRun` itself** — if a procedure is doing that, the sub-agent isn't carrying its own weight yet. **There is no bespoke tier and no per-class variant.** Vision is not an exception either: `userContent` can return content blocks, so an image/document parser only differs by naming a `claude-*` model.

Two independent options shape the call, and between them they cover every sub-agent in the repo:

| | **no `outputSchema`** (prose out) | **`outputSchema`** (JSON out) |
| --- | --- | --- |
| **no `readTools`** (default, `maxTurns: 1`) | `compactSummarySubAgent` | `scanJobSubAgent`, `enrichJobSubAgent`, `parseResumeSubAgent`, `logoVerifierSubAgent`, `applicationCriticSubAgent`, `profileEnrichmentCheckSubAgent`, `shortlistJobsSubAgent`, `applicationDeciderSubAgent` |
| **`readTools` + `maxTurns > 1`** | (unused) | `memoryConsolidationSubAgent`, `companyBasicInfoSubAgent`, `applicationDraftingSubAgent`, … |

## Transform vs judgement

Two classes — but the class is a **prompt-design decision you make when writing the sub-agent, not a different mechanism.** It shows up in code as exactly one thing: whether the def declares `readTools`. There is no separate transform helper, no separate loop; everything else (truncation detection, abort propagation, forced-schema retries, metering, capture) is one code path. Don't reintroduce a per-class entry point — as three near-copies they had already drifted into three different answers for each of those.

- **Transform** — input→output is a deterministic conversion (PDF→JSON, one job→summary). All context front-loaded, **no read tools declared**, so `maxTurns` stays at its default of 1 and the single turn is forced to the sub-agent's **output schema** (`tool_choice: {type: "tool", name}`). The model can only emit one thing, so it can't drift.
- **Judgement** — the task needs to read context the parent didn't pass, or weigh tradeoffs that benefit from "peek at X before deciding." Declare narrow read-only side tools and raise `maxTurns`; the loop terminates when the model emits the **output schema**.

**An output schema is not a tool.** Both classes hand the model a `tools` entry and force it with `tool_choice`, but that is only because `tools` + `tool_choice` is the sole mechanism the Messages API (and DeepSeek's compatible endpoint) offers for constraining output to a JSON schema. Nothing dispatches it — there is no `handle()`, no `parser`, no `ToolDef`; emitting it ends the loop and its payload is the return value. Hence the naming (`SubAgentOutputSchema`, `outputSchema`, `COMMIT_*_SCHEMA` consts) and two hard rules: an emitted output schema is **never** traced as a tool span, and **never** written to `TokenUsage.toolName`. Only genuinely dispatched read tools get either. The `readTools` in the same array *are* real tools and do get both.

The litmus: **would a perfect version of this sub-agent ever want to read something the parent didn't already include?** Yes → judgement. No → transform. Picking wrong is a correctness bug: a transform wrapper around a task that needs iterative reads under-reads and drops signal.

**The class does not decide `reasoning`** — the two axes are orthogonal, and "it can't drift" is about *what* it can emit, not about how well it thought first. A transform with a real call to make wants a scratchpad every bit as much as a judgement one does (`scanJob` is a transform and has the most elaborate scratchpad in the repo); a judgement sub-agent's multi-turn read loop is not a substitute for one either, since the turns gather evidence and the final emission still commits in property order.

## Why sub-agents over inline reasoning

- **Cost.** Every tool result a pipeline-agent reads stays in the conversation as cache_create that turn and cache_read on every turn after, for the rest of the session (see [cost.md](cost.md)). A sub-agent's inputs load fresh per call; its scratch work never enters main history; only the compact result lands — a 90%+ reduction for work that produces large intermediate context. `shortlistJobsSubAgent`: ~$0.12 as a sub-agent vs ~$2-3 as main-chat turns for the same round.
- **Isolation.** A 100–200 KB raw payload that would otherwise sit in the conversation forever stays outside it; only the structured result crosses back.

Use inline (regular tools) instead when the work benefits from multi-turn back-and-forth where the user can interrupt/redirect, when the intermediate context is genuinely user-facing, or when the task is too small to justify the fixed overhead (~$0.05–0.30 per sub-agent).

## Sub-agent diligence signals (removed)

Sub-agents no longer have any AdminNote signal channel. The universal `observation` / `confusion` / `capabilityRequest` output-schema fields (and the `subAgentSignals.ts` machinery behind them) were removed. Friction a sub-agent hits — bad inputs, contradictory source data, a missing capability — is now surfaced only after the fact by the offline [sub-agent runtime audit](../scripts/audits/sub-agent-runs/README.md), which replays what sub-agents actually returned in prod.

## How a sub-agent reasons before it answers — the `reasoning` field

**Every def declares one, and it is REQUIRED**, exactly like `maxTokens` and for the same reason: the answer is per-sub-agent, and a silent default would hide the choice. The vocabulary lives in [`platform/llm/reasoning.ts`](../src/server/platform/llm/reasoning.ts), shared with the main agent's [`hank/call.ts`](../src/server/agent/hank/call.ts).

```ts
reasoning: { mode: "scratchpad", guidance: "Walk the gates in order and…" }
reasoning: { mode: "thinking", budget: 1024 }
reasoning: { mode: "none", why: "Pulls stated facts out of one posting — nothing to weigh." }
```

**Which mode is even AVAILABLE follows from the call, not from taste.** A forced `tool_choice` is incompatible with extended thinking (DeepSeek answers `Thinking mode does not support this tool_choice`, HTTP 400), and every sub-agent that emits an output schema forces one on its last turn. So:

- **`scratchpad` — the answer for anything with an output schema** (12 of 15 today; the other three are `none`). `runSubAgent` PREPENDS a private `analysis` string property to every output schema the def declares, marks it required, and appends the ordering note to the schema description. The def supplies only `guidance` — what to actually walk through — and the shared framing ("fill this FIRST, before any other field… then fill every other field to match the conclusion you reached; never emit a value that contradicts your own analysis") has exactly one copy, in `scratchpadProperty`. **Don't hand-write an `analysis` property into a schema.** That's what this replaced: seven divergent copies under three names (`analysis`, `assessment`, `notes`) while five judgement sub-agents silently had none. Treat its absence as the thing needing justification, not its presence — an unused scratchpad costs a few hundred output tokens against a wrong verdict that costs the user a role.
- **`thinking` — needs an unforced call, and no sub-agent uses it.** Real extended thinking needs somewhere with nothing to force, which here means the main agent (tool_choice "auto") and prose-mode sub-agents, which send no tools at all. `compactSummarySubAgent` is the only sub-agent that structurally *could*, and it was **measured worse**: budget=1024 scored 2/5 and 3/5 against 4/5 with it off, twice restating the durable state its prompt says to omit, at ~53s vs ~34s (2026-07-28) — the same result the `applicationDecider` A/B got in 2026-06-21. Prose is also exactly where a scratchpad can't help, since the product IS the text and a summary that shows its work is a worse summary. If a def declares `scratchpad` with no output schema, `runSubAgent` throws at resolve time rather than silently dropping it.
- **`none` — a pure extraction with nothing to weigh**, and `why` is required so it reads as a decision rather than an omission. `enrichJob` (stated facts out of one posting), `parseResume` (transcribe one résumé), and `compactSummary` per the measurement above.

**Why the scratchpad works: schema property order is load-bearing.** A forced tool call emits its arguments token-by-token in property order, so the model commits an early field before it has reasoned about the later ones. That's why the injected `analysis` is *prepended* rather than appended, and it's the same rule that governs the def's own fields:

- **Order each per-item batch verdict `{ reason, verdict }`**, not `{ verdict, reason }` — `shortlistJobsSubAgent` and `applicationDeciderSubAgent` do. It composes with the injected scratchpad rather than being replaced by it: `preScanJobBatchSubAgent` has both, because the scratchpad reasons across the whole chunk while the per-job `rationale` is the note that ships to the user next to that role.
- **Same rule for a generated payload, not just a verdict** — `memoryConsolidationSubAgent` orders each write `{ path, mode, reason, content }` so the quote-anchored `reason` lands before the `content` it justifies; with `content` first, the "reason" degrades into a citation invented to fit text already written (exactly the fabrication the audit caught).
- **A field that must follow the analysis should say so** ("Set AFTER `analysis`, matching its conclusion") — the injected field is always called `analysis`, so those references stay true.
- **For a plain extraction, put the dense field first** — `enrichJobSubAgent` leads with `summary`, then the scalars it grounds; no verdict to front-run, which is the same judgement its `mode:"none"` records.
- **Reordering schema properties is always safe** — consumers read by key name, `required` order is cosmetic. Pure prompt-behavior change, zero downstream risk.

The `analysis` a model writes is captured on `SubAgentRun.output` (the runner records the raw emission, not the parsed result), so the audit harnesses can read what it actually weighed. Most `parse` implementations then discard it.

## Output shape: verdict-per-item for batch decisions

When the input is a list of N entities and the output decides each one, **never** ask the model to emit "the subset of IDs to skip/pick." That's free recall against opaque strings — the model silently drops tail items past ~20–30 entries. The fix: present inputs as a **1-based numbered list** (never show the cuid) and require a `verdicts` array of length exactly N where position i is the decision for input i. The orchestrator maps verdicts back to entity IDs by position — the model can't omit a position without it being visible.

Adopted by `preScanJobBatchSubAgent` (`{rationale, verdict}` per job, verdict from a `keep`/`skip:*` vocabulary) and `shortlistJobsSubAgent` (`{reason, verdict}` per candidate). Use it whenever input is a list and each item gets an independent decision. NOT for generative outputs (no input list) or single-output sub-agents (the scan-step enrich/match each run on ONE job — the per-job fan-out is itself the structural guarantee). Position-mapping merge should default missing positions to the **safest** verdict (`keep`/`borderline`), validate values against the enum, and use position only — never let the model emit an entityId.

**Give each item its own rationale — don't hoist one rationale per outcome bucket.** `preScanJobBatchSubAgent` used to emit the verdicts array plus a separate `skipRationales` object holding ONE shared sentence per skip reason. It cost twice: the model had to keep two fields in sync (and the prompt burned several paragraphs coordinating them), and since the note is what the user reads next to the closed role, a bucket holding sales roles, PM roles, and a defense-domain role told the user all three were skipped for whichever one the model happened to describe. Group by outcome in the *write* if the write batches (pre-scan closes one batch per `JobCloseReason`, each job carrying its own note) — not in the schema. **Adding an outcome value should be one entry in one table**: the verdict vocabulary, its enum, the prompt's bullet list, and the verdict→`JobCloseReason` mapping all derive from `PRE_SCAN_SKIP_REASONS` in [preScanJobBatch.ts](../src/server/subagents/registry/preScanJobBatch.ts) — mirror that when a schema's per-reason prose starts appearing in more than two places.

## Sub-agent text that flows back to the user must be user-facing at the source

When a sub-agent's output-schema field is quoted to the user verbatim — a per-job `reason` in a widget payload, a `shortlistJobsSubAgent.proposalNote`, a `skipNote` — write it in user-facing language **at the source**, baked into the schema field's `description`. Don't rely on the caller to translate; by the time Hank receives the output, the system prompt's translation discipline can't reach inside the sub-agent's emit. Concretely: emit "Anthropic has an unfinished scan from yesterday with jobs still waiting on your call," not "Anthropic ACTIVE since yesterday, walkthrough unfinished." **The voice rule has ONE copy** — `USER_FACING_VOICE` in [subagents/lib/voice.ts](../src/server/subagents/lib/voice.ts), interpolated into every such field's description: address the reader as **"you"/"your"**, never by name, never "the user"/"the candidate". It's a constant because third person is what leaks, and it leaks from the INPUT: `profile.md` opens "Benjamin is targeting leadership roles", so a field that doesn't say otherwise mirrors it straight back out as "matches the user's thesis" — printed next to a company on the user's own screen. Stated per-file it had already drifted: two sub-agents spelled it out verbatim, four didn't mention it, and `findCompaniesSubAgent.oneLineReason` taught the wrong voice by example ("payments-infra roles match *the user's* thesis").

**Which fields take it is a real distinction, not a blanket.** It goes on text written TO the user (discovery `oneLineReason`/`summary`/`provenance`, board `reason`, `scanJob.reason`, `preScan` rationale, critic `userNote`, decider soft-hold note, profile probes). It must NOT go on text written **as** them — the cover letter and short answers are first person in the candidate's voice, and `applicationDraftingSubAgent` deliberately carries no voice rule. Nor on Hank-facing strings: a tool result, a `panel_edits` relay, and a context block are *about* the user and stay third person ("the user unchecked Synthesia"). Mixing those two up is what makes both sides read wrong.

One further constraint for fields slotted into fixed templates (`preScanJobBatchSubAgent.verdicts[].rationale`, `scanJobSubAgent.reason`, both landing on `JobInteraction.skipNote`): lead with a **noun phrase** ("Sales and partnerships roles"), not a copular sentence — the caught-up text slots the fragment after `they're ${detail}`.

**Interpolating a shared fragment turns a plain string into a template literal, and that fails silently.** A `"…${USER_FACING_VOICE}…"` compiles fine and ships the placeholder to the model verbatim; converting to backticks then breaks on any markdown-quoted \`field name\` inside. Both happened here. Grep the built descriptions for `${` rather than trusting tsc. The chat-side translation rules live in Hank's system prompt ([hank/system.ts](../src/server/agent/hank/system.ts)); internal-only fields (entityType / rung numbers / category enums) stay raw.

## The tool-loop (judgement) contract

Declare `readTools` and `maxTurns > 1` and it runs the loop: `tool_choice: "auto"` for early exploration turns, then a forced `tool_choice: {type:"tool", name}` for the final phase to guarantee termination. The helper dispatches read-tool calls against the same `ToolDef` handlers the pipeline-agents use (no drift), tracks per-turn usage, and applies `cache_control` to the stable system/tools/initial-message prefix automatically. See [runSubAgent.ts](../src/server/subagents/lib/runSubAgent.ts) for the machinery and [types.ts](../src/server/subagents/lib/types.ts) for every field a def can declare — don't hand-roll it.

- **Turn budget + the forced-output phase (why "exhausted N turns" happens).** Free exploration runs for `maxTurns` (**default 1** — looping is opt-in, so a one-shot transform is just the degenerate case of this loop); the forced phase begins at `forceOutputFromTurn` (default `maxTurns` — only the last turn) and is retried `forceOutputAttempts` times (default 3) before the loop returns `ok:false, "exhausted N turns"`. So the real ceiling is `max(maxTurns, forceOutputFromTurn + forceOutputAttempts - 1)`, and the extra forced turns only ever run when the model still hasn't committed (never on a healthy run, which returns the instant it emits its output schema). The multiple forced attempts exist because **DeepSeek intermittently ignores a forced `tool_choice`** — a single forced turn was the sole cause of every prod turn-exhaustion (Anthropic never flakes; `preScanJobBatchSubAgent`, which forces from turn 1 and thus gets many forced attempts, is 100% reliable). If a sub-agent legitimately needs deeper exploration, raise `maxTurns` — do **not** remove the cap (it's what triggers forcing at all). See [llm-providers.md](llm-providers.md#deepseek-endpoint-quirks-handled-in-withdeepseekrequestdefaults).

- **Front-load AND tools, not either/or.** Pass everything the sub-agent likely needs up-front (reduces turns); tools handle the cases the parent didn't anticipate.
- **Parent passes path _references_, not content** (`contextPaths: ["profile.md", …]`) — the sub-agent loads them, keeping the parent's own context lean.
- **Side tools ([`SUB_AGENT_READ_TOOLS`](../src/server/subagents/lib/readTools.ts)): `read_memory` + `list_memories`,** extended by composition (`[...SUB_AGENT_READ_TOOLS, myLookup]`) with structured DB lookups when needed. **Side tools must be read-only.**
- **Chunk large inputs.** Output tokens are usually the rate-limiter; split an unbounded list into N parallel calls (`Promise.all`) each handling a slice. `preScanJobBatchSubAgent` chunks at `CHUNK_SIZE = 30`. Mark the shared prefix's own block with `cache_control` so the chunks read it from cache. **Keep the chunk boundary invisible to the model** — it gets a plain numbered list and no "chunk 2/5" label, so its verdicts can't depend on where in the board its slice fell. That's only possible because every output is strictly per-item; the moment a chunk is asked for a judgement about the WHOLE input (pre-scan used to ask each chunk for a company status, merged by a unanimity rule) you've made each call's answer depend on a split it can't see. Push that judgement to the caller, which has the full picture.
- **`serverTools`** carries Anthropic server-side tools (`web_search_20250305`); the URL hunter and `findCompaniesSubAgent` use it. `max_uses` caps the budget.
- **`outputSchema` is singular, and there is no multi-output mode.** One existed (`outputSchemas: SubAgentOutputSchema[]` plus an `outputSchemaChoice` knob picking what a forced turn forced) and was deleted with its only user: `shortlistJobsSubAgent`'s `decline_shortlist`, a second shape that turned out to be a conclusion the CALLER could derive from the per-job verdicts already in the first shape — and that could contradict them when it didn't (declining a pool holding two clear fits). If you want a second shape, first check it's genuinely a different SHAPE rather than a decision derivable from the one you already emit; `meta.outputSchemaName` survives only because `SubAgentRun` records which schema was emitted.

## Don't give sub-agents write tools

Enforced at the toolset boundary — `SUB_AGENT_READ_TOOLS` is the default; extend by composition, never by adding a write tool. **A sub-agent's read tools are ordinary `ToolDef`s in [agent/tools/registry/](../src/server/agent/tools/registry/)**, same as Hank's — they're just left out of `hankTools` (`fetch_url`, `test_scrape`, `probe_ats`, `read_reusable_application`). Don't define one next to the sub-agent that uses it: `test_scrape` / `probe_ats` lived in a `hunterTools.ts` beside the hunter and `read_reusable_application` inside `applicationDrafting.ts`, which meant two other sub-agents imported a ToolDef out of a third. A judgement sub-agent runs in a loop, and a write tool in a loop is a foot-gun (multiple calls, partial-state writes). The **only** write is the parent's, driven by the returned output schema through a single parent-side handler call: the sub-agent emits its output once with a complete payload, and the orchestrator module (entity writes) persists it after the call returns. This is the `shortlistJobsSubAgent` → [`seedBoardStances`](../src/server/procedures/registry/shortlist/seedBoardStances.ts) and `companyBasicInfoSubAgent` → [commitHuntedUrl.ts](../src/server/procedures/registry/enrichCompanies/commitHuntedUrl.ts) pattern. Never mid-loop — and, per "A sub-agent file holds LLM I/O and nothing else" above, never in the sub-agent's own wrapper either.

## Aborting sub-agents (Stop button)

The chat route's `AbortSignal` propagates through `ToolContext.signal` into the parent tool handler, into `runSubAgent`'s ctx, and into every `client.messages.create(req, { signal })`. Mid-API-call the SDK throws `APIUserAbortError`, which `runSubAgent` **re-throws** — for every sub-agent, looping or one-shot (bypassing the normal "sub-agent failed → `{ok:false}`" path) — so the main loop's tool-dispatch catch runs the stoppedByUser persistence, and nothing carries on working after Stop. It's also why an aborted run is deliberately not captured to `SubAgentRun`. **A caller that aborts its own siblings on purpose has to catch it**: the scan fan-out tears down its in-flight workers on a rate-limit wall via its own chained controller, and swallows the abort per worker so the partial result (with `rateLimited` set) still comes back. Any sub-agent that opens its own outbound `fetch` forwards `signal` into it too (chain via `parent.addEventListener("abort", …, {once:true})`). The litmus: anything that spends tokens, opens an HTTP connection, or could outlive the user's interest belongs behind `signal`; in-process synchronous work doesn't need it.

## Quality risk: sub-agents see less context

A main-agent flow draws on the full system prompt + conversation history + cross-session memory; a sub-agent sees only what you front-load or fetch via tools. That's the speed-up **and** the risk. The `shortlistJobsSubAgent` recall benchmark made it concrete: 100% recall where the user's `profile.md` thesis captured the relevant preferences, 0% where the live agent's picks were driven by cross-session signals never written down. **The mitigation that carried it was the written-down memory, not the tool loop** — the compaction-maintained `profile.md`, front-loaded by the caller's context loader (which is why that sub-agent could later drop its read tools without regressing the benchmark: the paths its prompt named were already being front-loaded). A `read_memory` loop is the fallback for signal you *can't* name in advance. When designing one, ask which signals the live agent uses that aren't in the obvious inputs, whether they're path-addressable, and whether a UI affordance (like the shortlist widget's checkboxes) lets the user cheaply correct mistakes.

**Frame exploration as discipline, not cost.** Judgement sub-agents shipped with anti-exploration framing ("extra reads are a cost — commit your output directly") observably under-read. Use a `# Exploration discipline` section that names the high-leverage reads and gives a concrete decision rule ("spend 1–3 turns on targeted reads, each answering a nameable question; when answered, commit"), and cap turns generously (an unused turn costs nothing; a forced premature commit costs wrong output). `applicationDraftingSubAgent` and `preScanJobBatchSubAgent` carry this framing.

**But a class is a choice you can revisit — and "it does read something" is not the test.** The same guidance also said to front-load a `list_memories` snapshot "so the sub-agent knows what paths exist". On `shortlistJobsSubAgent` that snapshot grew to hundreds of paths, the bulk of them `companies/*.md`, while the ONE that mattered — the company being shortlisted — was already front-loaded by name. The framing worked, in the literal sense that every captured prod run spent at least one turn reading: what it bought was a second full-context call per round for a peek at a list that was noise by construction. It's now a transform, with `companies/{slug}.md`, `profile.md`, and the candidates' own `jobs/{slug}.md` notes all front-loaded.

The lesson isn't "prefer transforms" — it's that a path LIST is not the same affordance as the paths themselves, and an unbounded `listMemories()` dump degrades as the user's memory grows. Front-load the notes you can name; keep the loop for signal you genuinely can't name in advance (`companyBasicInfoSubAgent` doesn't know which URL it needs until it probes). Before adding a loop, check the read is one the caller couldn't have done itself — and if you're removing one, check the same list.

## Surfacing sub-agent activity + trace plumbing

The `trace` / `signal` plumbing that nests sub-agent activity under the parent tool chip is owned by **[tools.md → `ToolContext`](tools.md)**. In short: it rides the `RunContext`, and a tool handler's `ctx` already IS one — `runAgentTurn` set `trace.parentToolUseId` to that tool's id when it built the ctx, so forwarding `ctx` verbatim is the whole wiring. All of it is optional and no-ops outside a chat dispatch. Read that section before wiring a new sub-agent's traces.

## Cost tracking

Each sub-agent gets its own `operation` value in `TokenUsage`. When adding one: add the operation name to the union in [usage/track.ts](../src/server/platform/usage/track.ts), update the inline comment on `TokenUsage.operation` in [schema.prisma](../prisma/schema.prisma), and use it as the def's `name` — `runSubAgent` records usage per turn from there, so nothing calls `recordUsage` by hand (a def's `usageNotes` disambiguates multi-call stages). No migration — the column is a plain `String`. **The client comes from [`resolveLlmClient(userId, { model })`](../src/server/platform/llm/resolveClient.ts), never `new Anthropic(...)`** — the runner does that once, and passes the resolved `model` + `billedToServer` to both `messages.create` and `recordUsage`. The sub-agent declares WHICH model as a `const MODEL: LlmModel` at the top of its own file (with its audit history as a comment), and that model runs verbatim — vision transforms simply name a `claude-*` model, since DeepSeek can't take image/document blocks. Read [docs/llm-providers.md](llm-providers.md) and re-audit before changing any pin.

## Testing

Every judgement AND transform sub-agent has a paired audit script under [scripts/regression/sub-agents/](../scripts/regression/sub-agents/) that runs ~5 fixtures through the sub-agent and pipes the output to an Opus 4.8 LLM-judge for a pass/warn/fail verdict, with a deterministic exact-match fast path for pinnable discrete fields. Shared infra is in [scripts/regression/sub-agents/lib/](../scripts/regression/sub-agents/lib/); the aggregator is [run-all.ts](../scripts/regression/sub-agents/run-all.ts) (`--only <name>` runs one, `--list` enumerates).

**A fixture is just a hand-written input object.** Because a sub-agent takes its whole context as an argument and writes nothing, there's no injection mode and no dry-run flag — the harness constructs the input, calls the sub-agent, and grades what comes back.

**When a read tool would reach past the fixture, pass a tool DOUBLE — never a flag that changes the def.** `runSubAgent`'s optional fourth argument (`SubAgentRunOptions.toolDoubles`) swaps the handler behind a tool the def already declares, matched by name; a name the def doesn't declare throws, so a double can replace a capability but never add one. The prompt, the tool description, the schema, and the turn budget are byte-identical to production — the audit grades the real call. `application-drafting.ts` is the reference: its synthetic candidate's past applications live in the fixture, `read_reusable_application` is doubled to serve them, and the harness derives BOTH the front-loaded catalog and the doubled tool's answers from that one fixture object, the way `loadPastDrafts` + `loadReusableApplication` derive them from one row. The one surviving input flag that shapes tools — `preScanJobBatchSubAgent`'s `closedBook` — is not a harness affordance: production sets it whenever a caller front-loads the whole pool.

**Adding a sub-agent → ship an audit script alongside it** and register it in `run-all.ts`. **Changing an existing sub-agent → re-run its audit before merging** and paste the verdict line into the PR. Audits need `--live` when `.env` points at the prod DB (they're read-only regardless).
