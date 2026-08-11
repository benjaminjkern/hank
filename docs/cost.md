# Token cost — mental model + investigation playbook

Read this before you "optimize a tool" or "fix the cost of a phase." The intuition most people start with is wrong.

## Cost lives in the context, not in the tools

Every tool in [src/server/agent/tools/](../src/server/agent/tools/) is deterministic TypeScript. **Zero of them consume Anthropic tokens.** What costs tokens is the **assistant reply that contains the `tool_use` block** — the model reads the whole conversation history plus the system prompt to decide to make that call. Removing a mutator like `close_job` or `update_job_interaction` doesn't remove its telemetry cost; the model pays rent on the whole apartment every time it crosses the room.

The only tools whose _results_ meaningfully add cost are the ones that dump a lot of content back into the conversation — `scrape_jobs_for_company` (one row per job; big boards = 50–200 rows), `read_job_description` (full posting body), `fetch_url` (cleaned page text). Everything else returns a status/id confirmation under 200 B. **These big-result tools are the real cost drivers** — the bulk of tool-result content that lands in history comes from `scrape_jobs_for_company` + `read_job_description`.

## Cache_create dominates the bill, not cache_read

Most input tokens flow through `cache_read`, which tempts the conclusion "cache is working, we're fine." That misses the unit economics: `cache_create` is **12.5× the per-token cost of cache_read** (see the pricing table). So even when most input is cache_read, the majority of the bill is cache_create.

**The lever is "how much new content arrives per turn," not "how much history persists."** New content per turn = the latest user message + any tool results that just came back, and tool results dominate. Every `scrape_jobs_for_company` call adds its payload to cache_create on the next turn, then to cache_read on every subsequent turn — which is why the big-result tools above drive spend.

## What's tracked

All instrumented via `recordUsage` in [src/server/platform/usage/track.ts](../src/server/platform/usage/track.ts). Tools that touch the network but never call Anthropic (ATS scrapers incl. the headless ones, application-question fetchers, `fetch_url`, all DB-only tools) produce **zero LLM cost** and are correctly absent. If a new tool doesn't call `client.messages.*`, don't add `recordUsage` to it.

| Operation                  | Model      | Call site / notes                                                                                              |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `chat`                     | deepseek-v4-pro | 1 per agent turn in a chat message |
| `profile_enrichment_check` | haiku-4-5       | 0–1 per `runWhatsNext` — rung-0 verdict gate; pre-gate skips most calls |
| `compact_summary`          | haiku-4-5       | 1 per compaction (summary pass) |
| `memory_consolidation`     | sonnet-4-6      | 1 per wrap — tool loop; runs BEFORE compaction, from `runConsolidateSessionMemory` |
| `parse_resume`             | sonnet-4-6      | 1 per resume upload (vision → Anthropic) |
| `logo_verifier`            | haiku-4-5       | 1 per company enriched (vision → Anthropic) |
| `shortlist_jobs`           | deepseek-v4-flash | 1 per round — transform (no tools). Was a judgement tool loop, and every captured prod run spent ≥1 extra turn re-sending a ~15k-token context; front-loading what it read cut the round to a single call |
| `application_decider`      | deepseek-v4-flash | 1 per job — draft/skip/ask_user verdict; cached on `JobInteraction.draftDecision`; gates `application_drafting`. Transform (no tools): it decides whether a usable prior EXISTS, so it's shown a catalog of past work rather than the bodies — reading those is `application_drafting`'s job |
| `application_drafting`     | deepseek-v4-flash | 1–4 per draft — judgement; only fires for the decider's `draft`-verdict items. The extra turns are `read_reusable_application` fetching a comparable prior letter/answer, which is the whole reason it's a loop |
| `application_critic`       | sonnet-4-6      | 1 per draft — post-draft recruiter-lens critic; feeds revisions back to the drafter |
| `find_companies`           | sonnet-4-6      | 1–12 per call — grow-the-watchlist judgement; `web_search` (10-use budget) + `fetch_url` available (decides). Merges the former `discovery_search` + `company_suggestions` |
| `company_basic_info`       | sonnet-4-6      | 1–20 per call — judgement + web_search/scrape probe tools (free); high `maxTurns` (giving up early is costly) |
| `enrich_job`               | sonnet-4-6      | scan pass 1 — user-independent enrichment (body → summary + scalars), cached on `Job` |
| `scan_job`               | sonnet-4-6      | scan pass 2 — per-user match verdict (summary + thesis → SCANNED / CLOSED) |
| `pre_scan_job_batch`           | sonnet-4-6      | 1–15 per call — PRE_SCAN pt1 (metadata-only bucketing); skipped on cold-start |

**Legacy operations** — old `TokenUsage` rows only, no live emitter: `prescan_deep`, `whats_next`, `eval_fit`, `scrape_html`, `users_distill`, `rescan`, `company_hunter` (alias of `company_basic_info`). The `UsageOperation` union in [track.ts](../src/server/platform/usage/track.ts) keeps them so old rows still price. Harness-side keys (`qa_audit_persona`, `session_audit`, `subagent_runtime_audit`) are dev spend, not product.

**Model column caveat (post-DeepSeek migration):** except the two **vision** rows (`parse_resume`, `logo_verifier`, which run on the named Anthropic model), every operation runs on **DeepSeek** — `deepseek-v4-pro` or `-flash` per the `MODEL: LlmModel` each sub-agent declares in its own file. Any `sonnet-4-6` / `haiku-4-5` name on another row is the historical Anthropic tier that op used to run on, before the model became a single declared id; `recordUsage` records what actually ran, so `pnpm usage` prices correctly regardless. See [llm-providers.md](llm-providers.md).

Two reading notes: **tool-loop sub-agents fire N rows per call** (one `TokenUsage` row per turn, disambiguated by `turn=N` in `notes` — sum all of them); **a session wrap is two sequential calls** (`memory_consolidation`, then `compact_summary`). It fires at deterministic boundaries (`runWrapSegment` when a company ends, `runCommitProfile`), not from a token threshold.

Adding a call site: add `recordUsage`, add the operation string to the `UsageOperation` union (type-only, no migration), and pass `resolved.model` + `resolved.billedToServer` from `resolveLlmClient` to BOTH `messages.create/stream` and `recordUsage`. Populate `toolName?` (from `primaryToolName(final.content)` for agent turns) when meaningful. **User-stopped turns still bill** — `runAgentTurn` catches the abort, reads `stream.currentMessage.usage`, and writes a row tagged `stopped_by_user`.

## Server-key vs user-key spend

`TokenUsage` rows record tokens, not money flow — the `userId` says who triggered the call, not whose bill got hit. Which key paid is snapshotted per row in `TokenUsage.billedToServer` (`true` = server key, `false` = the user's own key); `/admin/usage` splits the dollar total into "billed to us" vs "billed to users' keys" on that flag, while `pnpm usage` reports the unsplit total.

## Investigation playbook

Two entry points share one cost calculation (`costOf` in [pricing.ts](../src/server/platform/usage/pricing.ts)) — a disagreement is a same-file bug, not two implementations:

- **`pnpm usage`** ([scripts/cost/usage.ts](../scripts/cost/usage.ts)) — CLI, aggregates by `(operation × model)`.
- **`/admin/usage`** ([src/app/admin/usage/](../src/app/admin/usage/)) — same numbers in the browser.

When a spike shows up: (1) check the token-type breakdown — high `cache_create` means new content is landing (a `scrape_jobs_for_company` on a big board, a chain of `read_job_description`), high `cache_read` means the conversation ran long without compaction; (2) cross-reference tool-result sizes via a `LENGTH(content::text)` query over `ChatMessage` role=TOOL for the day; (3) check whether `compact_summary` ran between companies. If `pnpm usage` and the Anthropic dashboard disagree by >5%, suspect a call site not going through `recordUsage` (grep `client.messages.` vs `recordUsage` callers) or a swallowed insert (`[usage] recordUsage failed:` in stderr).

## Pricing source of truth

[src/server/platform/usage/pricing.ts](../src/server/platform/usage/pricing.ts) holds the rate table, keyed by model-id substring, imported by both entry points. Update it when Anthropic/DeepSeek publish new prices. Claude rates ($/M tokens; web search $10/1k requests):

| Model      | input   | cache_create | cache_read | output  |
| ---------- | ------- | ------------ | ---------- | ------- |
| Opus 4.7   | $15 / M | $18.75 / M   | $1.50 / M  | $75 / M |
| Sonnet 4.6 | $3 / M  | $3.75 / M    | $0.30 / M  | $15 / M |
| Haiku 4.5  | $1 / M  | $1.25 / M    | $0.10 / M  | $5 / M  |

DeepSeek (`deepseek-v4-pro` / `-flash`) and `fable` rates live in the same table; DeepSeek `cache_create == input` (no cache-write surcharge) and bills web search as tokens, not per-request.

## Cost ideas backlog

Forward-looking tactics and rejected ones, kept so they aren't re-litigated. **v0 usage shape:** single-user, short bursts, each job read once per session — this rules out anything that depends on amortizing work across re-reads, and favors within-session reductions with no quality risk.

**Deferred (forward-looking):**

- **Haiku-summarize `read_job_description` results** — cache a ~500-token summary on `Job.summary`, return it by default with a `full: true` escape hatch. Only pays back on re-reads, so it waits for multi-user / persistent re-engagement.
- **Per-mode prompt narrowness** — re-split the mode-aware Hank prompt to trim ~3k static-prefix tokens per cold session. Small win; re-introduces the spontaneous-CRUD dead-ends the merge fixed. Revisit if the static prefix becomes a meaningful share of cost.
- **Aggressive system-prompt audit** — a further ~17% prompt trim exists but is ~$0.10/heavy-day against a treadmill of feature growth. Not a meaningful lever today.
- **Bespoke application-form extraction sub-agent** — for `unsupported`-ATS apply pages; rare enough not to move the needle.
- **Generic `create_sub_agent` tool** — premature abstraction; revisit if purpose-built sub-agents reveal shared scaffolding.

**Considered & dropped:**

- **Paging `scrape_jobs_for_company` via a `list_jobs` tool** — the agent needs the full list for PRE_SCAN; paging adds round-trips without saving cache_create.
- **Cap `scrape_jobs_for_company` at top-N** — a quality change, not a cost one; silently drops jobs the PRE_SCAN pass should see.
- **Disable hosted `web_search`** — ~1% of spend; not worth losing ATS-URL hunting.
- **Trim inline tool descriptions** — cached after the first call; marginal benefit, real disambiguation risk.
