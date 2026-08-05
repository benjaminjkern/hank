# Memory

Three things in this codebase get called "notes" — different lifecycles, consumers, and write paths. This doc is the inventory + the decision guide for "I have a piece of context — where does it go?"

## The three storage shapes

1. **`MemoryNote`** — markdown files keyed by path. Free-form, path-addressed, agent-authored — Hank's notebook. Reads/writes via [memory tools](../src/server/agent/tools/registry/writeMemory.ts); storage in [store.ts](../src/server/memory/store.ts); path allowlist in [paths.ts](../src/server/memory/paths.ts).
2. **Inline note fields** on domain rows (`Event.notes`, `Opportunity.notes`, `Contact.notes`, the per-status `closeNote`/`deferNote`/`pauseNote`/`blockNote`, …) — bounded freeform attached to one entity. Read/written through the entity's normal tools, surfaced in the focused-entity views. There is deliberately **no general-purpose "notes about this pursuit" field on `JobInteraction`** (dropped 2026-07-25, migration `20260725120000_drop_job_interaction_notes`): `jobs/{slug}.md` covers the same ground better — the agent reads/writes it by slug, the consolidation pass folds it, and it outlives the row. Per-status "why" stays in the reason/note pairs.
3. **`ChatSession.summary`** + **`AdminNote`** — session-scoped recall and admin-only feedback log.

Before inventing a fourth shape, check whether one of these is the right home.

## MemoryNote paths

Every entity note is addressed by its **slug, never a cuid** — `companies/{slug}.md` (`Company.slug`), `jobs/{slug}.md` (`Job.slug`), `opportunities/{slug}.md` (`Opportunity.slug`), `contacts/{name-slug}.md`. Ids are error-prone for the agent to reproduce, so none are shown. The store's `resolveFK` accepts slug-or-cuid (legacy rows still resolve); server callers holding an id build the path via `jobNotePath(jobId)` / `opportunityNotePath(id)` in [store.ts](../src/server/memory/store.ts). Existing notes were migrated cuid→slug (`20260710130000_memory_paths_to_slugs`).

| Path                      | Auto-loaded                              | Purpose                                                                                                                     |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `profile.md`              | Hank + shortlist SA: always   | **Everything durable about the user** — search thesis (role kind + why + avoids) AND constraints/voice/patterns (comp floor, location, seniority, allergies, how they write). Organized by `## ` sections. |
| `resume.md`               | Hank: always (if exists)      | **The user's background**, in full detail — every résumé they've uploaded, merged, plus what they've told Hank in chat. Raw facts only: roles, dates, scope, technologies, education. How to FRAME that background is `profile.md`. |
| `frequent_questions.md`   | Hank: always                  | Curated stock answers to recurring application questions. Format: `## <question>` then the answer, never a bare fragment.   |
| `companies/{slug}.md`     | when company focused                     | Per-company context — what they do, connections, why watchlisted, past-skip reasons. (Status transitions now live on the CompanyEvent feed, not in this note.) |
| `jobs/{slug}.md`         | when job focused                         | **The** home for per-job context beyond the structured columns (recruiter-call intel, eval notes, interviewer prep). Use sparingly. |
| `opportunities/{slug}.md`   | when opportunity focused                 | Per-lead notes — recruiter pitch style, agency read, what to ask.                                                          |
| `contacts/{name-slug}.md` | not yet auto-loaded                      | Per-person notes — voice, who they place for. Slug = kebab-cased `Contact.name`.                                            |

`daily/{YYYY-MM-DD}.md` and `weekly/{YYYY-WW}.md` are allowlisted for a v1 rollup feature but have no writer today. Path validation lives in [validatePath](../src/server/memory/paths.ts); adding a pattern means extending the regex set, adding a `PathInfo` variant, extending `resolveFK` in [store.ts](../src/server/memory/store.ts) if it should populate a denormalized FK, and updating the `read_memory` tool description.

## Inline note fields (entity-attached)

| Field                                                                | Tool                                                            | Surfaced in                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `JobInteraction.closeNote`                                           | `close_job` (with `reason`) · `update_job_interaction` to correct | Job-detail header                                                        |
| `JobInteraction.deferNote`                                           | `defer_job` (with `reason`) · `update_job_interaction` to correct · shortlist defer-the-rest (copied deterministically at commit — `deferNote ← proposedReason`) | Job-detail header; the company's next-job picker; fed back to the shortlist ranker as a role's `priorDeferNote` on a re-rank |
| `JobInteraction.coverLetter` / `.shortAnswers`                       | `save_application_answer` / the drafting workflow; user-edited in side panel | Job-detail right-panel artifacts                             |
| `CompanyInteraction.closeNote`                                       | `close_company` (with `reason`)                    | Company chip, dashboard skipped pile                                      |
| `JobEvent.notes` (table `Event`)                                     | `log_job_events`                                                | Per-job timeline (`list_job_events`, job-detail card)        |
| `CompanyEvent.notes`                                                 | `logCompanyEvent` seam · `log_company_events` / `edit_company_event` / `delete_company_event` tools | Company "Recent activity" card (first-class, not a job-event flatten)     |
| `OpportunityEvent.notes`                                             | `log_opportunity_event`                                         | Opportunity timeline                                                      |
| `Opportunity.notes` / `.closedReason`                                | `create_opportunity` / `update_opportunity`                     | Opportunity header                                                        |
| `Contact.notes`                                                      | `create_contact` / `update_contact`                             | OpportunityContact card; future contacts view                            |
| `Job.deletionRecommendedReason`, `Company.deletionRecommendedReason` | `recommend_*_for_deletion`                                      | `/admin/deletions`                                                        |

## Session + admin

- **`ChatSession.summary`** — compaction-time summary pass (flash); replaces the previous summary each time. Loaded into the next system-prompt build as "Earlier conversation summary." `ChatSession.compactedAt` is stamped by `runCompactSession`.
- **`AdminNote`** — one helper ([`upsertAdminNote()`](../src/server/platform/admin/adminNotes.ts)), now written **only** by the two offline audit harnesses (the runtime writers — observation/capability tools, sub-agent signals, anomaly flaggers, client-event fan-out — were all removed). Match-or-insert on `(userId, category, dedupKey, dismissed=false)` — repeats bump `occurrenceCount`. Triaged via `/admin/notes`; runtime agents neither write nor read it. See [admin.md → AdminNote: single write path + categories](admin.md#adminnote-single-write-path--categories).

**Resume:** a `Resume` row is the uploaded FILE and nothing else (bytes, name, MIME) — there are many per user. What a résumé SAYS lives only in `resume.md`. Both upload entry points (the `attach_resume_to_profile` agent tool and the Documents page's `POST /api/documents/resume`) go through [`mergeResumeIntoBackground`](../src/server/procedures/registry/attachResumeToProfile.ts), which reads the current note, has `parseResumeSubAgent` merge the document into it, and writes the whole thing back. So a second résumé ADDS to the background rather than replacing it. Every sub-agent reads it through one function, [`readResumeBackground`](../src/server/entities/resume/store.ts) — there is no summary variant. See [ui.md](ui.md).

## Who writes memory

- **Hank inline** — the DISCIPLINE block in the system prompt carries a per-path "write to X when Y happens" trigger (see the table below) so the agent writes as signal arrives, not only at compaction. The `write_memory` tool has a clobber guard (a `replace` shrinking a load-bearing slot below half its size is refused, pointing the agent at `section`/`append`) plus a `section: "<## heading>"` merge mode for editing part of a note.
- **Wrap-time consolidation** — [`memoryConsolidationSubAgent`](../src/server/subagents/registry/memoryConsolidation.ts) (via [`runConsolidateSessionMemory`](../src/server/procedures/registry/consolidateSessionMemory.ts), at every company wrap + `commit_profile`, just before the transcript is compacted) writes multiple paths as a safety net for signal that didn't trip an inline trigger. Three write modes: **`section`** (rewrite one `## heading` in place — the default for `profile.md` whenever the signal refines something already there), **`append`** (genuinely new ground only), **`replace`** (agent-generated content only, and subject to an anti-shrink veto — except `frequent_questions.md`, which is exempt so its curated set can be reconciled). A `section` write skips the veto: it's scoped by construction, and shrinking one section is exactly how two duplicates get merged back into one.
  - **Why `section` exists.** Append-default with no in-place edit is what bloats a note with near-duplicate sections — several `## Dealbreakers`, a `## Knowledge boundaries` plus a `(continued)` twin, the same rule split across two slightly-different headings. Refining a fact had exactly two options — append a near-duplicate or replace the whole note — so it always appended. If you're reading a consolidation trace and see a heading ending in "(continued)" / "(refined)", that's the failure this mode is for.
- **Documents page** — the only direct _user_ write path: `PUT /api/documents/memory` → [`saveUserDoc`](../src/server/entities/narrativeDocs.ts) lets the user hand-edit `profile.md` / `frequent_questions.md` / `resume.md`. Last-write-wins (no clobber protection) — a "vanished" edit is usually a later consolidation write, not a bug.

The agent must never name a `MemoryNote` path to the user — it says "captured" / "noting that for next time," never "writing to `profile.md`."

## Decision guide: "where does this context go?"

Walk top-down, stop at the first match:

1. **A preference, constraint, voice signal, or thesis shift that spans the whole search?** → `profile.md`. Write inline immediately, and pass `section` when the note already has a heading covering it.
2. **Single sentence attached to a specific entity in the pipeline?** → inline `.notes` on that entity — but note a **job** has no such field: a sentence about a role goes on the event you're logging (`log_job_events({notes})`) or, if it isn't tied to an event, into `jobs/{slug}.md`.
3. **The structured "why" behind a status transition?** → the reason field paired with the status (`closeReason` + `closeNote`, `deferReason` + `deferNote`, `closedReason` on Opportunity).
4. **Richer-than-a-sentence context belonging to a Company / Job / Opportunity / Contact?** → the matching `MemoryNote` path.
5. **A stock answer to an application question?** → `frequent_questions.md`.
6. **Agent-observed friction / tool misbehavior / user confusion?** → nowhere at runtime. Runtime agents no longer file AdminNotes; such friction is surfaced only after the fact by the offline audit harnesses.
7. **Within-session state?** → don't store it; compaction summarizes it into `ChatSession.summary`.

**Profile-doc precedence when the two disagree:** `profile.md` wins on anything about what the user WANTS or REQUIRES (thesis, comp, location, seniority, allergies, voice) and on how to FRAME their background; `resume.md` wins on background FACTS (what they actually did).

**Prerequisite gap ≠ a place to write.** If `profile.md` / `resume.md` is empty/shallow, that's the profile-intake gate's business, not a memory write. Two readers share one read model ([profileInventory.ts](../src/server/entities/profile/profileInventory.ts)): [`runChatTurn`](../src/server/procedures/registry/chat/runChatTurn.ts) calls `isProfileObviouslyEnriched` every turn — a pure Postgres length check — to decide whether Hank's prompt gets the profile-intake body, and [`runWhatsNext`](../src/server/procedures/registry/whatsNext.ts) rung 0 calls the fuller [`runProfileEnrichmentGate`](../src/server/procedures/registry/profileEnrichmentGate/index.ts), which falls through to the [`profileEnrichmentCheckSubAgent`](../src/server/subagents/registry/profileEnrichmentCheck.ts) judge on borderline cases — the length check stays deterministic on this side of the boundary, and the judge is handed the two slot bodies verbatim so it rules on substance only. There is **no stored mode**: the old `ChatSession.currentFlow` column is gone, so intake is re-derived per turn and ends when [`runCommitProfile`](../src/server/procedures/registry/commitProfile.ts) (consolidate → verdict gate → compact-if-pass) flips the read.

**Anti-patterns:** don't write durable state to `ChatSession.summary` (compaction overwrites it); don't write per-session ephemera to `profile.md`; don't duplicate inline `.notes` into a `MemoryNote`.

### Inline-write triggers

The DISCIPLINE block names a trigger per path so the agent has a pattern to match, not a vague "journal more":

| Path                      | Trigger                                                                    | Example                                                     |
| ------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `profile.md`              | User adjusts their target shape, states a constraint, or names a cross-session pattern about themselves | "I'm pivoting from IC to EM"; "I always want IC, never lead" |
| `resume.md`               | User states a background FACT no résumé carried, or corrects one          | "the platform team was 4 people, not 40"                   |
| `frequent_questions.md`   | User types out an answer to an application-style question                  | "for 'why this company' I usually say…"                    |
| `companies/{slug}.md`     | Multi-sentence context about a company beyond a one-liner                  | User's take on the team, why they care                     |
| `jobs/{slug}.md`         | Any prose about a specific pursuit that isn't a status reason or an event note (there's no `JobInteraction.notes` to fall back on) | "what the team said on a call"          |
| `contacts/{name-slug}.md` | Any context about a person beyond name + role                             | Voice, who they place for                                  |

## Cascade behavior on entity hard-delete

`MemoryNote` rows survive admin hard-delete of the linked Company/Job/Opportunity/Contact — the FK columns are `ON DELETE SET NULL`, so path-addressed content stays queryable. The path is the source of truth; the FK is an index hint. Global paths (`profile.md`, `resume.md`, `frequent_questions.md`) have no FK. Full chain in [architecture.md → Cascading deletes](architecture.md#cascading-deletes--db-for-hard-delete-explicit-for-user-scoped).
