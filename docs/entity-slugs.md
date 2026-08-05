# Entity slugs

The main Hank agent addresses companies / jobs / opportunities / contacts by **human-readable slugs**, never opaque cuid ids. Slugs are self-checking — `stripe-senior-software-engineer` is far harder for the model to transpose, truncate, or hallucinate than `cmxy9f3k2q8a1b2c3d4e5f6g7`, and a close-but-wrong slug is visibly wrong. This is scoped to the **LLM-facing surface only**: sub-agents, deterministic widget round-trips, the in-memory `EntryTarget` (the ephemeral dispatch signal), and internal server code keep cuids.

**One word for this concept: `slug`.** Don't reintroduce "handle" or "ref" as synonyms — they used to appear interchangeably (the column was `slug`, the resolvers were `resolve*Ref` returning `*Ref` types, and prompts/tool descriptions said "handle") and that made the code hard to read. The value is a **slug** everywhere: DB columns, function names, tool-param descriptions, and prompt text. The one carve-out is a value that may be **either a slug or a raw cuid** (the resolver inputs, because replayed ids still resolve) — those are named `slugOrCuid`. (Unrelated homonyms are fine and untouched: the `handle()` execute fn on `ToolDef`, React `useRef`, the widget `optionRef` row-key, and the `<job-ref>` chat token — none of those are the entity identifier.)

## The slug columns

- `Company.slug` — global `@unique`, derived from the canonical name. Also the memory-path key (`companies/{slug}.md`).
- `Job.slug` — global `@unique`, minted `{companySlug}-{titleSlug}` with a **smart suffix** (location → department → numeric) on duplicate titles at one company. Immutable once set — a re-scrape that changes the title does NOT re-slug (the slug is a stable permalink).
- `Opportunity.slug` / `Contact.slug` — per-user (`@@unique([userId, slug])`), from label / name.

All three are nullable in the schema; the id-fallback resolvers keep any un-slugged legacy row working.

## The modules — [platform/slug/](../src/server/platform/slug/) + [entities/resolveBySlug.ts](../src/server/entities/resolveBySlug.ts)

Deliberately split: `platform/slug/` is the domain-blind half (a string slugifier and a
retry-on-collision minter that takes a `write` callback and knows no tables), while the
resolvers query all four entity tables and so live with the domain.

- `slugify(input, {stripUrl?, maxLength?})` — the ONE canonical slugifier (the re-export in `memory/paths.ts` delegates here).
- `mintSlug(fallbackId, candidates, write)` — the generic minter ([mintSlug.ts](../src/server/platform/slug/mintSlug.ts)): write a candidate, catch the P2002 unique violation, fall through to the next (numeric suffixes after the named candidates; the row's cuid as a last resort). Race-safe. The per-entity minters that build the candidates + supply the `write` live in each entity folder — [`mintJobSlug`](../src/server/entities/jobs/jobSlug.ts) / [`mintOpportunitySlug`](../src/server/entities/opportunities/opportunitySlug.ts) / [`mintContactSlug`](../src/server/entities/contacts/contactSlug.ts) (mirrors [`companySlug`](../src/server/entities/companies/companySlug.ts)). **Must run OUTSIDE any enclosing `$transaction`** — mint after it commits. (The parallel scrape upsert in [upsertScrapedJobs.ts](../src/server/entities/jobs/upsertScrapedJobs.ts) mints per-job, lazily backfilling any null-slug row it touches.)
- `resolveCompanyBySlug / resolveJobBySlug / resolveJobsBySlug / resolveOpportunityBySlug / resolveContactBySlug / resolveJobInteractionFromJobSlug` — each accepts a **slug OR a raw cuid** (slug first, id fallback). Failure returns `{ok:false, message, dedupHint}` the handler turns into `toolError("ENTITY_NOT_FOUND", …)`; the message lists a few valid slugs so the model self-corrects in-turn.

## The tool-boundary convention (follow for every new agent tool)

An LLM-facing entity param is named for the entity, not the id: `company`, `companies`, `job`, `jobs`, `opportunity`, `contact` / `contacts` / `primaryContact`, `sourceJob`. Loosen it to `z.string()` and resolve at the top of `handle`:

```ts
const r = await resolveCompanyBySlug(ctx.userId, input.company);
if (!r.ok) return toolError("ENTITY_NOT_FOUND", r.message, r.dedupHint);
const companyId = r.value.id; // use internally exactly as before
```

Optional params that default to the focused entity only resolve when present; the focused id read from the session stays a raw cuid. Any tool **result string** the LLM reads emits the slug, not the cuid (`updated ${r.value.slug}`). Worked examples: [createJobs.ts](../src/server/agent/tools/registry/createJobs.ts), [logJobEvents.ts](../src/server/agent/tools/registry/logJobEvents.ts) (batch `resolveJobsBySlug` preserves partial-success behavior), [createOpportunities.ts](../src/server/agent/tools/registry/createOpportunities.ts).

## What stays a cuid (deliberately)

- Widget payloads (`shortlist_proposal` ids, `next_job_picker` / `next_company_picker`, …) — the LLM never authors these; the widget handlers in [`src/server/widgets/`](../src/server/widgets/) round-trip them deterministically.
- The `focus` UiEvent client contract, `ChatSession.focused*Id` slots, bundled-action internal signatures, and sub-agent I/O.
- **Memory paths `jobs/{slug}.md` / `opportunities/{slug}.md`** — NOW slug-addressed (converted 2026-07-10; migration `20260710130000_memory_paths_to_slugs`). No ids are shown to the agent anywhere. The conversion was atomic across `validatePath`, the store's `resolveFK` (accepts slug-or-cuid so legacy rows still resolve), and every sub-agent writer/reader (decider / drafter / consolidation / opportunity loader build the slug path via `jobNotePath` / `opportunityNotePath` or the loaded row's `.slug`). `companies/{slug}.md` / `contacts/{name-slug}.md` were already slug-based.

## Where the agent sees slugs

`scrape_jobs_for_company` compact JSON (`co`=company slug, `id`=job slug), `list_companies` / `list_jobs` rows, the **watchlist hint block** in [hank/system.ts](../src/server/agent/hank/system.ts), and every `create_*` result summary. The `# Translate, don't parrot` block tells Hank the slugs are internal — say the real name/title in chat.
