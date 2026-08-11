# ATS scrapers

Hank reads company job boards directly. **Three readers, tried in order, and all three are deterministic** — no LLM runs in the scrape path and no LLM ever emits a job posting:

1. **A wired provider** — nineteen ATSes with a hand-written parser (the `AtsProvider` union in [types.ts](../src/server/scrape/types.ts) is the authoritative list). Always wins when it matches.
2. **A stored recipe** — a declarative read-plan for a board no provider recognizes, executed by [recipe/runRecipe.ts](../src/server/scrape/recipe/runRecipe.ts). See [Learned boards](#learned-boards) below.
3. **The deterministic probe** — [generic/genericProbe.ts](../src/server/scrape/generic/genericProbe.ts) works an unknown board out from first principles, for free, and emits the recipe as a by-product.

Provider implementations live **one file per provider** under [src/server/scrape/ats/providers/](../src/server/scrape/ats/providers/); [ats/index.ts](../src/server/scrape/ats/index.ts) assembles them into an ordered registry and derives the public API, and [ats/shared.ts](../src/server/scrape/ats/shared.ts) holds the `AtsProviderModule` contract + the helpers every provider shares (`rawAttrs`, `fetchText`, `MIN_REAL_JOBS`); the domain-blind text helpers they also lean on (`htmlToText`, `decodeEntities`, `titleCaseSlug`) live in [src/utils/](../src/utils/).

> **Per-provider endpoint URLs, quirks, and foot-guns live as comments inside each provider file** (e.g. [providers/greenhouse.ts](../src/server/scrape/ats/providers/greenhouse.ts), [providers/workday.ts](../src/server/scrape/ats/providers/workday.ts)), plus [types.ts](../src/server/scrape/types.ts) / [headless.ts](../src/server/platform/browser/headless.ts) where the logic lives there. That hard-won knowledge is intentionally kept WITH the code, not duplicated here — open the provider's file (or grep the parser: `parseGreenhouse`, `fetchAllWorkday`, `ripplingLocation`, …) for the gotcha. This doc is just the architecture + how to add one.

## How it works end to end

Each provider file exports an `AtsProviderModule` (`provider` / `detect` / optional `matchesQuestions` + `fetchQuestions`). `ats/index.ts` holds the ordered `REGISTRY` array and turns it into `detectAts` + `fetchApplicationQuestions` by iterating it.

1. **Detect** — [`detectAts(url)`](../src/server/scrape/ats/index.ts) walks the registry and returns the first provider's `detect(url)` that yields an `AtsHandler` (scheme-less input is normalized through [`normalizeUrlInput`](../src/utils/url.ts) first). Custom-domain ATSes (Workday, iCIMS) have no shared host to regex, so they're **discovered** from a branded careers page by [`resolveBoardFromCareersPage`](../src/server/scrape/resolveBoardFromCareersPage.ts), which the hunter's `test_scrape` tool calls automatically whenever a URL isn't a recognized board; that resolver now falls through to the generic probe, so the hunter reaches learned boards with no prompt changes of its own. The board-slug hunter also probes candidate boards via `probeAtsBoards`.
2. **Fetch + parse** — [`scrapeViaAts(handler)`](../src/server/scrape/ats/index.ts) runs the handler. A handler is either simple-GET (`{ provider, jsonUrl, parse }` — one GET returns all jobs with full content) or bespoke (`{ provider, fetchedUrl, fetchAll }` — paging, POST, GraphQL, per-job detail, or headless render). Both emit a `ScrapedCompany` of `ScrapedJob`s.
3. **Application questions** — [`fetchApplicationQuestions(url)`](../src/server/scrape/ats/index.ts) walks the registry and delegates to the first provider whose `matchesQuestions(url, hints)` returns true; no match → `{status:"unsupported"}`.

### `truncatedAt` is the completeness contract, and it is load-bearing

`diagnostics.truncatedAt` ([types.ts](../src/server/scrape/types.ts)) means **"`jobs` is not the whole board"** — either the provider's cap bit or a detail fetch dropped a row. The two causes are deliberately conflated: a dropped row is missing from the list exactly like a capped one.

It is not just a display hint. [`detectAndApplyClosures`](../src/server/entities/jobs/upsertScrapedJobs.ts) **skips the entire pass** when it's set, because a posting the scrape never fetched is indistinguishable from one that came down — and delisting is terminal, applied globally, for every user watching the job. A provider that caps without emitting `truncatedAt` will silently delist live roles. So when you add or change a cap: emit `truncatedAt` by comparing the board's real total against **`jobs.length`**, not against the cap constant, or a failed detail fetch on a sub-cap board slips through.

Cap policy: **300 jobs for every plain-fetch provider**, sized against the 90s `TIMEOUT_MS` in [scrapeJobsForCompany.ts](../src/server/procedures/registry/scrapeJobsForCompany.ts) for the worst class (an N+1 detail fan-out plus the per-job upsert round trips). The four headless providers stay far lower (25–30) — each detail there is a full Chromium render on a shared browser, so the limit is memory and wall-clock, not request count. Boards genuinely larger than 300 (enterprise Workday/iCIMS/Amazon run into the thousands) will therefore always report `truncatedAt` and never auto-close anything; that's the intended trade, since the alternative is wrongly closing them.

Two providers can't report truncation at all and say so in their headers: **gem** (no paging args, introspection disabled, errors masked — a server-side cap would be undetectable) and **workable** (single GET returning the whole board; the paginated v3 endpoint omits descriptions, so switching would be a regression).

### Stop reaches every fetch — don't hand-roll a controller

A user Stop has to tear down an in-flight board read, and the requests are spread over 19 provider files several `fetchAll` frames below the entry point. So the abort signal is **ambient**, not a parameter: the entry (`scrapeUrl`, or a tool handler for `fetch_url` / `probe_ats` / `test_scrape`) opens a scope with [`withScrapeSignal`](../src/server/scrape/scrapeSignal.ts), and each fetch asks for its signal with `scrapeFetchSignal(timeoutMs)` — its own timeout combined with whatever the scope carries. A new provider using `fetchText` gets this for free; a provider that calls `fetch` directly must use `scrapeFetchSignal` rather than building an `AbortController`, or it will silently ignore Stop.

Two consequences worth knowing:

- **`scrapeUrl` THROWS on abort** instead of returning `{ok:false}`. A failed scrape means "this board is unreadable" and callers set the company `BLOCKED` / `CANNOT_SCRAPE`, so degrading a Stop into that shape would let pressing Stop permanently set companies aside. The throw lands in the abort handling the tool dispatch and [`runUserMessage`](../src/server/agent/runtime/runUserMessage.ts) already have.
- **A timeout is not a Stop.** `scrapeFetchSignal` uses `AbortSignal.timeout`, which raises a `TimeoutError`; `isUserAbortError` deliberately doesn't match it, so a slow board still reads as a scrape failure rather than a user abort.

## Structured fields: four columns + the `attributes` bag

Each `ScrapedJob` carries the **canonical role attributes** — the cleaned, user-displayed scalars, defined once in [roleAttrs.ts](../src/server/entities/jobs/roleAttrs.ts) and spread into `ScrapedJob` as `Partial<RoleAttrs>`, so a new one becomes fillable by every provider without touching this type — **plus** a **raw `attributes` Json bag** dumped wholesale by `rawAttrs()` (every provider field minus description blobs and a small `RAW_ATTR_SKIP` noise set). The bag feeds PRE_SCAN + the scan/enrich agents and is deliberately uncurated so a field can't be lost just because nobody wired a column for it. Don't confuse it with `Job.enrichedAttributes` (LLM-extracted scalars from the prose body — see [enrichJob.ts](../src/server/subagents/registry/enrichJob.ts)). A null column is usually the company not publishing that field, not a parser bug — verify against the live API before assuming a regression.

## Application-questions support

Only the providers that wire `matchesQuestions` + `fetchQuestions` (greenhouse / lever / ashby / workday / teamtailor / gem / workable / jazzhr) expose scrapeable apply-form questions. The rest omit both, and the router returns `{status:"unsupported"}` **by design** — leave them omitted whenever a provider's apply flow is genuinely login/auth/SPA-gated. **A learned board never supports questions**: nothing in the registry matches its URL, so the router returns `unsupported` with no extra wiring. When questions are unsupported the walkthrough hands off gracefully (`formUnavailable` in [walkthrough/jobArm.ts](../src/server/procedures/registry/walkthrough/jobArm.ts)): Hank asks the user to describe any cover-letter / short-answer fields and drafts them.

### `Company.greenhouseSlug` — reconstructing the apply-form URL

The URL/ATS hunter stamps `Company.greenhouseSlug` whenever it lands a Greenhouse board, and the apply-form fetcher reuses it. This matters for **custom-domain** Greenhouse integrations (Databricks, Stripe, CoreWeave, …): Greenhouse returns each job's `absolute_url` as `<company>.com/careers?gh_jid=<id>`, which does **not** host-match `*.greenhouse.io`, so the apply-form scraper can't tell it's a Greenhouse board from the per-job `sourceUrl` alone. The stored slug lets it rebuild the canonical `boards.greenhouse.io/<slug>/jobs/<id>` embed URL and fetch questions. Null when the company is on a different ATS or hasn't been hunted yet.

## Headless path

**A browser is a recipe-authoring tool, not a scraping tier.** The reference deployment can't run Chromium, so [`browserCapability()`](../src/server/platform/browser/browserCapability.ts) is asked BEFORE anything tries — it returns `"none"` unless `HEADLESS_BROWSER=local` is set, and the four SPA providers ([providers/shopify.ts](../src/server/scrape/ats/providers/shopify.ts), google, meta, netflix) check it before their lazy `await import(…)`, so Playwright never loads where it can't run and the error names the board rather than our machinery. Each still catches `HeadlessUnavailableError` as a belt (a local install can be missing).

The high-value use is **research**: `pnpm ats:research-board <url>` renders a board locally, watches which JSON the page fetches for itself, derives a recipe from that endpoint, and then **re-runs it with the browser closed** to prove it works browserless. What that produces is something prod can execute with no Chromium at all — which is how a "needs a browser" board stops being a permanent hole. DOM-scraping through a browser is the last resort, and it strands the board on machines that have one.

## Drift detection

Three harnesses, all free (no LLM, no DB):

- **`pnpm ats:verify-matrix`** — the wired-provider canary. Run it whenever you suspect a scraper regression, after any change under `scrape/ats/`, or periodically. Walks one sample board per ATS and checks list count, detail `rawContent` length, at least one concrete non-`"Remote"` location (guards silently-nulled structured fields), and form-questions status. Exits non-zero on any failure. ~3–4 min; headless rows print SKIPPED unless `HEADLESS_BROWSER=local`.
- **`pnpm ats:jobshape`** — offline, zero network. The accept/reject cases for `looksLikeJobArray` plus the feed and blob extractors. Run after ANY change under `scrape/generic/` — this is where a mistake is silent.
- **`pnpm ats:probe-corpus [url]`** — real unknown boards through the deterministic probe, with a declared baseline per row. Prints how much of the long tail is readable without an LLM, which is the number that says whether recon is carrying its weight. Network-dependent, so check a red row by hand before treating it as a regression; pass a URL for a verbose one-off.

For one-off debugging: [`scripts/ats/test-scrape.ts`](../scripts/ats/test-scrape.ts) (list) and [`scripts/ats/test-questions.ts`](../scripts/ats/test-questions.ts) (form).

## Adding a new ATS

1. **First ask whether you need one at all.** The generic probe + recipe runner already read a lot of the long tail; check `/admin/board-readers` for the board's family. A provider file is worth writing when several companies sit behind one `familyKey`, or when the board needs something a recipe can't express (faceted POST paging, GraphQL, a signed request).
2. **Pick the deterministic approach**, in order: public JSON API → embedded JSON in SSR HTML → HTML parse → **headless render** (research path first — `pnpm ats:research-board <url>` captures the SPA's own XHR and emits a recipe that works WITHOUT a browser; DOM-scrape only as last resort).
3. **Create the provider file** `ats/providers/{name}.ts` exporting an `AtsProviderModule`: the `{ATS}_RE` regex(es), the parser/fetcher functions, and the module object (`provider`, `detect(url)`). Add `{name}` to the `AtsProvider` union in [types.ts](../src/server/scrape/types.ts) and add the module to the `REGISTRY` array in [ats/index.ts](../src/server/scrape/ats/index.ts) (append in the detection order you want). Custom-domain ATSes (no host to regex) detect the canonical form in `detect()` and add a resolution branch to [resolveBoardFromCareersPage.ts](../src/server/scrape/resolveBoardFromCareersPage.ts), which `test_scrape` calls whenever a URL isn't a recognized board. Each `ScrapedJob` sets the four cleaned columns where available and `attributes: rawAttrs(rawJob)` — don't hand-pick keys. **Record any provider-specific quirk as a comment right there.**
4. **Questions.** No parseable form → omit `matchesQuestions`/`fetchQuestions` (the router returns `{status:"unsupported"}`). If questions ARE scrapeable, add a `matchesQuestions(url, hints)` predicate + a `fetchQuestions` fn to the module; add long-text types to `isProseQuestion` and structured types to `STOCK_FIELD_TYPES` in [types.ts](../src/server/scrape/types.ts) (never add `file`/`attachment` — those fall through to the decider).
5. **Verify end-to-end:** add a sample board row to [verify-matrix.ts](../scripts/ats/verify-matrix.ts), run it, then update the supported-ATS lists in the tool descriptions that enumerate providers — [testScrape.ts](../src/server/agent/tools/registry/testScrape.ts) (the full recognized-board list) and [probeAts.ts](../src/server/agent/tools/registry/probeAts.ts) (the slug-guessable subset).

## Learned boards

A board no wired provider recognizes is read from a **recipe**: a declarative plan — where the postings array lives, which key holds each field, how to page, how to get a body — stored as JSON on a `BoardReader` row and executed by [recipe/runRecipe.ts](../src/server/scrape/recipe/runRecipe.ts). The format is [recipe/types.ts](../src/server/scrape/recipe/types.ts).

**A recipe is DATA, never code, and no LLM ever emits a posting.** The model describes a locator; the runner fetches. That's what makes a hallucinated job structurally impossible rather than merely unlikely, and it's why the "no generic-HTML LLM fallback" rule this layer started with is still intact — the refusal was about an LLM producing postings, and it still does not.

Two things author recipes:

- **The deterministic probe** ([generic/](../src/server/scrape/generic/)) — free, no LLM. Tries well-known endpoints, RSS/XML feeds, embedded state blobs (`__NEXT_DATA__`, `__NUXT__`, flight rows, `data-page`), API-ish URLs in inline scripts, and finally robots.txt → sitemap → JSON-LD. The array it picks has to survive [`looksLikeJobArray`](../src/server/scrape/generic/jobShape.ts), which is deliberately the most conservative thing in the layer: a false positive is SILENT (a nav menu scrapes fine and is fiction), so it demands a distinct title column, a distinct identity column, and a corroborating job-ish column. `pnpm ats:jobshape` exercises it offline.
- **Recon** ([procedures/registry/reconBoard/](../src/server/procedures/registry/reconBoard/)) — the [`board_recipe`](../src/server/subagents/registry/boardRecipe.ts) sub-agent, on a probe miss. It never sees the page's HTML: [`buildPageEvidence`](../src/server/scrape/generic/pageEvidence.ts) sends a structural digest instead (blob OUTLINES, script URLs, a DOM skeleton, a sitemap summary), and it verifies its own work with the `test_recipe` read tool. Runs at most once per board, shared across every company on it, 14-day cooldown on failure.

**A learned board never delists.** `Job.closedAt` is global and terminal, so an inferred locator that quietly started returning a partial list would take live roles down for every user watching them. `detectAndApplyClosures` still MEASURES the missing set on these scrapes and reports it (`missingNotDelisted`, plus the overlap ratio the reader's health check reads) — it just withholds the write, and Hank offers the call to the user instead. `Job.lastSeenAt` carries the per-posting "absent since".

Three more guards, all in [upsertScrapedJobs.ts](../src/server/entities/jobs/upsertScrapedJobs.ts) / [recipe/validate.ts](../src/server/scrape/recipe/validate.ts): every run is validated wholesale (>20% bad rows, all-identical titles, or duplicate URLs reject the RUN, not the row); a learned run whose postings are already owned by another company is thrown away and the reader quarantined; and `sourceUrl` gets its own ladder, because it's `Job.sourceUrl @unique` — a guessed URL template is checked against live pages before a recipe carrying it exists.

## Sub-brands and deferred boards

A sub-brand that only hires under a parent and has **no own board** is reported `cannot_scrape` naming the parent, which lands the company as `BLOCKED` with `blockReason=NO_OWN_BOARD` (see [docs/lifecycle.md](lifecycle.md)) so Hank offers to track the parent instead of scraping all-brand jobs.

A board no provider recognizes is no longer automatically a dead end — it falls through to the probe, then to recon. What survives all three gets a `BoardReader` row with a null recipe, and **[/admin/board-readers](admin.md) is where that lands**: grouped by board-software family, ordered by how many companies sit behind each, with the reason recon gave. That table is the signal to invest in a provider file — it replaces the removed `capability:` AdminNote channel and is strictly better, because the row carries the actual recipe.
