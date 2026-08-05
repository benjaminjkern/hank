# Incomplete migrations & compat shims

**The single index of every unfinished refactor, back-compat path, and name-that-lies in this repo.** If you leave one behind, it goes here — see [AGENTS.md → Finish the refactor](../AGENTS.md). No entry = no shim.

Each entry states: **what** the old shape is, **why** it's still here, **what still depends on it** (with real row counts where the answer is "data"), and the **exact remaining steps** to finish. An entry is deleted when the migration lands — not edited to say "done".

> **Row counts are from the reference deployment on 2026-07-27.** Re-run the query in an entry before acting on it; "0 rows" is the thing that makes most of these cheap, and it can change.

**Status at last audit (2026-07-27, reason enums re-counted 2026-08-03):** 4 live data migrations unfinished · 7 chat-history compat readers (mostly legitimate) · 6 names that no longer match their meaning · 8 fully dead exports + 25 needlessly-public ones (but **zero** dead DB columns and **zero** orphan source files).

**Good news first:** all 79 files in `prisma/migrations/` are applied to prod — no pending DDL, no drift between the migrations directory and `_prisma_migrations`. Every item below is a _data_ or _code_ leftover, not an unapplied schema change.

---

## A. Live data migrations — started, never finished

These are refactors where the code moved but the rows didn't. Each is a "lazy backfill" that only fixes a row when something happens to touch it — so rows nothing touches stay wrong forever. **This is the category that matters most**: it's invisible until a query returns the old shape.

### A1. `Job.slug` — 11,225 of 19,700 jobs have no slug (57%)

- **Migration:** `20260630190000_add_entity_slugs` (applied). Docs ([docs/entity-slugs.md](entity-slugs.md)) describe slugs as the agent's addressing scheme — "a wrong slug is visibly wrong; a transposed cuid is undetectable."
- **Why still here:** no one-shot backfill was ever written. Two lazy paths mint on touch: [jobSlug.ts:47](../src/server/entities/jobs/jobSlug.ts#L47) ("lazily backfills a legacy null-slug job the scrape path touches") and [upsertScrapedJobs.ts:113](../src/server/entities/jobs/upsertScrapedJobs.ts#L113).
- **Depends on it:** every `resolve*BySlug` keeps a cuid fallback, and memory paths accept slug-**or**-cuid ([paths.ts:31](../src/server/memory/paths.ts#L31), [store.ts:135](../src/server/memory/store.ts#L135)) purely for these rows. 309 of the null-slug jobs have a `JobInteraction`, i.e. are user-reachable today.
- **Remaining:** write a one-shot backfill script minting `Job.slug` for all nulls (reuse `mintJobSlug`, batch + retry on P2002) → run against prod → make `Job.slug` non-null in the schema + migration → delete both lazy-backfill branches → drop the cuid fallback in `resolveJobBySlug` and the cuid branch in `paths.ts`/`store.ts`.

```sql
select count(*) from "Job" where slug is null;
```

### A2. `Contact.slug` (7 of 17 null) and `Opportunity.slug` (3 of 7 null)

- Same migration, same gap, much smaller. Both are small enough to backfill in one statement.
- **Remaining:** backfill both → non-null in schema + migration → drop their cuid fallbacks.

### A3. `MemoryNote` paths still cuid-addressed — 7 rows

- **Migration:** `20260710130000_memory_paths_to_slugs` (applied) moved memory paths to `jobs/{slug}.md`. 7 notes still carry a cuid path.
- **Depends on it:** the slug-**or**-cuid acceptance in [paths.ts:31](../src/server/memory/paths.ts#L31) and `resolveFK` in [store.ts:135](../src/server/memory/store.ts#L135).
- **Remaining:** rewrite the 7 paths (blocked on A1 — the jobs behind them may be slug-less) → drop the cuid branch.

### A4. `JobEventType.DRAFT_USED` — 485 rows, no longer emitted

- Draft usage tracking is gone entirely — the `*UsedAt` columns that replaced this event were themselves dropped in `20260729120000_drop_draft_used_at`. The events remain and nothing reads them.
- **Remaining:** decide delete-vs-keep-as-history. If keep, this moves to section C (accepted history) and stops being a migration. If delete: remove the 485 rows → drop the enum value → remove from [schema.prisma:471](../prisma/schema.prisma#L471).

---

## B. Chat-history compat readers — mostly legitimate, but audit them

Persisted `ChatMessage.content` JSON can't be rewritten without a data migration, and replay runs on every turn. These are the defensible shims. **Each still needs a decision: migrate the history, or accept permanently and note it here.**

- **`ShortlistCommitCard`** — [ShortlistCommitCard.tsx](../src/components/Chat/ShortlistCommitCard.tsx), a whole component + its `ChatPanel` wiring ([ChatPanel.tsx:1508](../src/components/Chat/ChatPanel.tsx#L1508)) kept only to replay the pre-2026-06-12 `<!--shortlist-commit:…-->` marker. Live path is `widget-response`. _Check whether any such marker still exists in `ChatMessage.content`; if not, delete the component._
- **Bare-`string[]` widget markers** — [widgets/parse.ts:167](../src/server/widgets/parse.ts#L167) accepts an older marker shape.
- **Replay-only shortlist widget family** — the shortlist board (docs/flows.md) replaced `shortlist_proposal` + `shortlist_scan_gate` + `shortlist_regen_gate`; nothing emits, submits, or dispatches them anymore. What survives, solely because persisted `pipeline_widget` blocks + submission markers in old sessions carry the kinds verbatim: the three entries in the `WidgetKind` union, their `def.ts` files (the proposal's `toText` + `tryParseShortlistProposal` ground model replay/scrollback), null-rendering `Widget.tsx` stubs (a pre-board session whose LAST message was a live widget mounts one and gets nothing — re-entering the company opens the board), the `ShortlistScanGatePayload`/`ShortlistRegenGatePayload` types, and `WidgetResponseCard`'s shortlist branch (scrollback cards for old submissions). A stale queued marker sent post-deploy falls through the dispatcher to Hank as plain text. _Decision pending: rewrite the history blocks to a tombstone shape and delete all of it, or accept permanently._
- **Optional-for-back-compat widget payload fields** — [widgets/types.ts:60](../src/components/Chat/widgets/types.ts#L60), [nextCompanyPicker/Widget.tsx:59](../src/components/Chat/widgets/registry/nextCompanyPicker/Widget.tsx#L59). Fields that are _actually_ required now but stay optional so old rows parse. Cost: every consumer handles an `undefined` that can't occur in new data.
- **`legacy:<sessionId>` run tree** — [admin/runs/[runId]/page.tsx:49](../src/app/admin/runs/%5BrunId%5D/page.tsx#L49) + `LegacyTag`/`LegacyBanner` UI, for the **51** `ChatMessage` rows with `runId = null` (vs 6,912 captured). _51 rows are keeping a second code path and two UI components alive in an admin-only surface._
- **`appendMessages` "legacy callers pass none"** — [appendMessages.ts:88](../src/server/agent/session/appendMessages.ts#L88). All params optional. If every caller now passes them, tighten the signature.

---

## C. Names that no longer match their meaning — accepted, no migration planned

Documented on purpose. Listed here so nobody "discovers" them and half-fixes one.

- **`ChatSession.stoppedByUser`** — now covers three cut-off causes (user Stop, socket drop, mid-stream fault), not just Stop. Kept to avoid a migration; the pill and resume note are deliberately cause-neutral. _Rename is a column migration + client mirror; low value._
- **`ANTHROPIC_KEY_ENCRYPTION_KEY`** — encrypts DeepSeek keys too. [keyCrypto.ts:10](../src/server/platform/llm/keyCrypto.ts#L10) is provider-neutral. Kept because it's a prod secret and renaming buys nothing.
- **`pipeline_status` / `pipeline_widget` / `pipeline_activity`** — persisted block-type strings in `ChatMessage.content` (`run_error` is a later sibling, correctly named). There is no pipeline layer; renaming needs a data migration and breaks replay. Called out in AGENTS.md already.
- **`@map` survivors** — `JobEvent` → table `Event`, `JobEventType` → type `EventType`, `Job.locationAndArrangement` → column `location`, `SubAgentRun.outputSchemaName` → column `finalToolName`. Prisma-level renames done, physical renames skipped. **Gotcha: raw SQL must use the physical names** — `select … from "JobEvent"` fails.
- **`TokenUsage.operation` aliases** — [track.ts](../src/server/platform/usage/track.ts) keeps `scrape_html`, `company_hunter`, `prescan_deep`, `users_distill` in the union solely so old rows type-check. No code path emits them. _Droppable once the rows roll off `pnpm usage`'s default window; `users_distill` says so in-line._
- **`VerificationToken`** — empty model kept as an Auth.js adapter convention (magic-link sign-in intentionally absent).
- **Two dedupKey spellings for one failure** — a failed slug lookup keys the audit either by the resolver (`resolve:company_not_found`, 26 call sites) or by the calling tool (`update_job:not_found:company`, 10 call sites). Both predate [slugLookupError.ts](../src/server/agent/tools/lib/slugLookupError.ts), which now renders both from one place via its optional `source` — so the split is one `opts` argument, not 36 hand-written strings. **Not collapsed because picking a winner changes live audit keys**, and the per-tool form is both more informative and the one matching AGENTS.md's documented `<source>:<failure mode>:<input shape>` shape. _To finish: pass `source` at the other 26 sites, delete the `resolve:` fallback, make `source` required._

---

## D. Doc link check

Not a migration — a check to run before merge, kept here because a moved file silently breaks every markdown link to it and nothing else in the repo catches that.

```sh
grep -rhoE "\]\((\.\./)?(src|scripts|prisma|docs)/[A-Za-z0-9_./-]+\)" docs/ AGENTS.md \
  | sed 's/^](//; s/)$//; s|^\.\./||' | sort -u \
  | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
```

---

## E. Dead code

Measured by scanning all 485 `.ts`/`.tsx` files (excluding `src/generated/`) for the 938 exported symbols, counting references outside the defining file. Two genuinely clean results worth recording: **zero dead DB columns** (every field in `schema.prisma` is referenced in code or a migration) and **zero unreferenced source files** — the only never-imported files are CLI scripts, Next.js convention files, and the ambient `src/lib/styled.d.ts`, all legitimate.

### E1. Fully dead values — defined, referenced nowhere at all (8)

Delete outright.

| Symbol | File | Note |
| --- | --- | --- |
| `ShortAnswerSchema` | [entities/jobs/jobInteractionInputs.ts](../src/server/entities/jobs/jobInteractionInputs.ts) | **AGENTS.md cites this by name** as the model example of "a domain input schema lives in `entities/`, and the tool imports it." No tool imports it. |
| `refreshCompaniesEngagement` | [entities/companies/engagement.ts](../src/server/entities/companies/engagement.ts) | The batch variant. The singular `refreshCompanyEngagement` **is** used (`markJobApplied`) — so nothing ever re-derives `IN_FLIGHT`/`IN_PROCESS` in bulk. Worth checking that's intended before deleting. |
| `looksLikeCuid` | [platform/slug/slugify.ts](../src/server/platform/slug/slugify.ts) | Dead in the exact module the slug-or-cuid compat in §A would use. |
| `opportunityNotePath` | [memory/store.ts](../src/server/memory/store.ts) | Sibling path helpers are used; this one isn't. |
| `isHeadlessAvailable` | [platform/browser/headless.ts](../src/server/platform/browser/headless.ts) | Providers check availability by catching `HeadlessUnavailableError` instead. |
| `closeHeadless` | [platform/browser/headless.ts](../src/server/platform/browser/headless.ts) | **Nothing ever shuts down the Chromium singleton** — no shutdown hook calls this. |
| `describeFixturesForOperation` | [audits/sub-agent-runs/fixtureRegistry.ts](../scripts/audits/sub-agent-runs/fixtureRegistry.ts) | |

> **Scanner caveat for whoever re-runs this:** the headless module is reached by `await import("@/server/platform/browser/headless")` and used as `headless.withHeadlessContext(...)`. A scan that only looks at static `import` statements will wrongly call the whole module dead. Grep for the bare identifier, not the import.

### E2. Exported but used only inside their own file — drop the `export` (24)

Not dead code, but a false public surface: each one reads as an API other modules depend on. `renderTurnForAuditor` · `COMMIT_CHUNK_FINDINGS_TOOL` · `AUDIT_WRAP_UP_TOOL` · `COMMIT_RUNTIME_FINDINGS_TOOL` · `FIXTURE_REGISTRY` · `HALT_CATEGORIES` · `QA_TAG` · `assertDbAllowed` · `resolveAuditCtx` · `appendRunReport` · `checkExpectedFields` · `LIST_COMPANY_EVENTS_PAGE_SIZE` · `LIST_JOBS_PAGE_SIZE` · `LIST_JOB_EVENTS_PAGE_SIZE` · `LIST_OPPORTUNITY_EVENTS_PAGE_SIZE` · `OPPORTUNITY_EVENT_TO_STATUS` · `computeWhatsNextOptions` · `withHeadlessPage` · `CLIENT_EVENT_SOURCES` · `CLIENT_EVENT_SEVERITIES` · `loadPickableJobs` · `SCAN_CLOSE_REASONS` · `SCAN_MATCH_BUCKETS`. (`PRE_SCAN_VERDICT_VALUES` came off this list when the pre-scan skip vocabulary collapsed into the module-local `PRE_SCAN_SKIP_REASONS` table.)

### E3. Exported types never imported anywhere (90)

Cosmetic — no runtime cost, and often a deliberate courtesy export next to a function. Flagged only so a future sweep knows the number and doesn't re-derive it. Not worth a dedicated pass; clean them up opportunistically when touching the file.

### E4. Vestigial parameters

- **`scrapeUrl(url, _userId, trace)`** — [scrape/index.ts:63](../src/server/scrape/index.ts#L63): both are unused, "kept in the signature for now so call sites don't need to change" (from when an LLM fallback needed cost tracking + trace emission). Drop both + update call sites.

### Re-running this scan

No dead-code tooling is installed (`knip` / `ts-prune` / `depcheck` are all absent). The scan above was a throwaway script: enumerate `export (function|const|class|type|interface|enum) <name>`, then for each name count `\b<name>\b` matches across every other file. Word-grep rather than import-graph — that's what makes it robust to namespace imports and dynamic `await import()`. Worth installing `knip` if this becomes routine.

---

## F. Harness affordances still inside a sub-agent def (0 — audits not yet re-run)

`runSubAgent` takes `toolDoubles` ([SubAgentRunOptions](../src/server/subagents/lib/types.ts)) so a fixture can back a declared read tool with fixture data while the def, prompt, tool schema, and turn budget stay byte-identical to production. All three `disableReadTools`-style input flags are gone (the last holdout was converted to a `read_memory` / `list_memories` double before its sub-agent — the shortlist reject-summary — was deleted with the shortlist-board overhaul).

`preScanJobBatchSubAgent` keeps the field, renamed `closedBook` to say what it means: **production sets it** ([`runPreScan`](../src/server/procedures/registry/preScan/index.ts), whenever a caller injects context, so the model can't reach past a front-loaded pool into live memory). It's a real prod branch, not a harness affordance.

**Remaining:** none — the shortlist-reject-summary harness went with its sub-agent.
