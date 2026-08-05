# The application page

One job's application as a shared document: every question its form asks, in
form order, with what's written for each and what's still blank. The user writes
on it, Hank writes on it, and the gap between the two is the product's richest
preference signal.

It's the same paradigm as [the shortlist board](flows.md) applied to
drafting — read that one first; this doc only covers what's different.

## What carries over from the board

| Board | Application page |
| --- | --- |
| `proposedVerdict` — Hank's stance | `proposedDrafts` — Hank's text |
| `placementVerdict` — what's drawn | the live `coverLetter` / `shortAnswers` |
| divergence ⇒ unrelayed user edit | same |
| relaying settles placement | relaying re-baselines `proposedDrafts` |
| marks preselect to Hank's proposal | Hank's draft IS the starting text |
| `commit_shortlist` writes memory | submit writes memory |

The consequence that matters in both: **a change reverted before sending is a
no-op**, because "edited" is derived from a comparison rather than stored as a
flag.

## What's deliberately NOT carried over

**There is no per-item verdict UI.** The board negotiates *whether* a role is in;
an application item either has text or it doesn't. So no Pick/Maybe/Pass
equivalent, no user-settable verdict, no commit gate on individual items. The
decider's `skip` / `ask_user` verdicts still exist — they decide what Hank
*writes* — but to the user they're just an empty item with a one-line note, and
filling it in is typing, not voting.

**The page does not close on submit.** The board closes because its stances
become statuses and there's nothing left to decide. An application's text stays
useful — it's the reuse corpus — so the page stays editable. What stops is the
*relay*: an APPLIED row's edits are housekeeping, not something Hank should be
asked to reconsider ([`RELAYABLE_STATUSES`](../src/server/entities/jobs/applicationDrafts.ts)).

## Data model

One column, [`JobInteraction.proposedDrafts`](../prisma/schema.prisma):

```jsonc
{ "coverLetter": "…" | null, "answers": [{ "question": "…", "text": "…" }] }
```

The text as Hank last wrote it. Re-stamped by every agent write and by every
relay; **never** touched by the user's own edit route, since that write diverging
from it is the whole mechanism.

Three states per item, and the difference between the last two is load-bearing:

- **entry present with text** — Hank wrote this; live text differing means an edit.
- **entry present, `null`** — Hank has seen this item empty; live text means the user wrote it from scratch.
- **no entry at all** — no baseline (a brand-new item, or a row from before the column existed). Live text reads as user-authored and relays as `wrote`.

`proposedDrafts` is not `*Reuse`. The reuse flag answers *may we reuse this
text later*; the baseline answers *did this change since Hank saw it*. They
disagree constantly — a user can un-set reuse on their own writing — so
[`isUserOwned`](../src/server/entities/jobs/applicationDrafts.ts) treats either
one as "hands off" and neither as sufficient on its own.

## Layers

- [`entities/jobs/applicationDrafts.ts`](../src/server/entities/jobs/applicationDrafts.ts) — the rules a WRITE depends on: `isUserOwned`, `applicationEditsFor`, `proposedDraftsPatch`, and the relay pair. Same cut as `boardStance.ts`.
- [`entities/jobs/applicationItemId.ts`](../src/server/entities/jobs/applicationItemId.ts) — `COVER_LETTER_ID` + `questionId`. Its own file because the form service and the authorship rules each need it and would otherwise import each other.
- [`views/application.ts`](../src/server/views/application.ts) — `loadApplicationView`, the payload. **Three audiences, one shape**: the panel, `view_application_questions`, and `read_application_drafts`.
- [`utils/diff.ts`](../src/utils/diff.ts) — `diffWords` / `renderWordDiff`. Domain-blind; word-level, whitespace-tokenized, so a re-wrapped paragraph isn't a change.

## The one write seam

Every Hank-authored write goes through
[`persistApplicationAnswer`](../src/server/entities/jobs/applicationQuestions.ts):
the drafting procedure, the critic's revisions, `draft_application_question`, and
`save_application_answer`. It owns the reuse flag, the parallel-array
maintenance, and the baseline re-stamp — so a new call site can't get two of the
three right and miss the last.

The user's edits go through
[`PATCH /api/jobs/[id]/application`](../src/app/api/jobs/[id]/application/route.ts),
one item per request, addressed by the same id the agent's tools use.

## The critic leaves the user's words alone

[`critiqueAndRevise`](../src/server/procedures/registry/draftApplication/critiqueAndRevise.ts)
reviews the whole form but only revises what `isUserOwned` says is still Hank's.
A critique of the user's own text still surfaces in `unresolvedIssues` — it just
isn't acted on by rewriting their sentences.

Without this guard the sequence *user edits the cover letter → Hank drafts a
newly-added short answer → the critic runs over the whole form* silently
overwrote the user's text and flipped its reuse flag off.

## Submit is the learning moment

[`runCommitApplication`](../src/server/procedures/registry/commitApplication.ts),
entered from the `confirm_application_submit` widget (fired by the chat widget or
the page's own button — same message either way):

1. read the divergences **before** anything re-baselines;
2. `markJobApplied`;
3. if anything diverged: settle the baseline, append a Hank-only `pipeline_activity` note carrying the rendered diffs, and run `runConsolidateSessionMemory`.

Step 3 costs an LLM call and only fires when the user actually changed
something. The consolidator's *Application rewrites are voice signal* section
governs what it's allowed to conclude
([memoryConsolidation.ts](../src/server/subagents/registry/memoryConsolidation.ts)).

## Navigation

`application` is a right-panel mode. It's reached from the job page's
Application card, the Documents artifacts list, `show_application`, and
automatically whenever drafting produces something (the job arm and both drafting
tools emit `buildApplicationEvents`). Breadcrumb: `Dashboard / Company / Role /
Application`.

The job page keeps a one-line summary card and a link; the editors live here.
Documents keeps its read-only cross-job list and links here to edit.
