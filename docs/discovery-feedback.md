# Discovery — the feedback loop

The company search proposes a batch, the user prunes it, and what they cut is
recorded, fed back, and learned from. Before this, the pruning was thrown away:
a declined name never reached the DB, so the same company could be proposed
again, and the reason it was wrong reached nothing at all.

Same family as [the shortlist board](shortlist-board.md) and
[the application page](application-page.md) — read either first; this doc covers
what's different.

## It stays a widget, on purpose

The board and the application page negotiate over **things that exist and
persist**. A discovery run is a **batch produced at a moment** — an event. The
code already treats it that way: `runDiscoveryArm` re-shows a pending checklist
as an unanswered question, while a new `direction` always searches fresh.

So the fix isn't a panel. It's that the checklist captured one bit per candidate
and discarded the rest.

## Suppression is advice, not a filter

`listSuggestionHistory` hands the search what was declined and why; the prompt
weighs it against this run's direction. Nothing filters the model's output
afterwards.

That's what makes the override channel free: `direction` is what Hank forwards
from the conversation, so *"actually I'd look at bigger companies now"* lands in
the same prompt as *"Trade Desk — declined, too big"* and the model reconciles
them. There is no un-decline tool and there shouldn't be — a past no is not a
ban, and code that enforced one would need its own escape hatch.

**One deterministic rule survives**: a name declined in the round that just
happened is never re-proposed. Asking again in the very next breath is the one
case with no legitimate reading. It rides on `inLatestRound`, derived from the
most recent `runId` that produced a decision.

The "fade" is the model's judgment, not a cutoff in code — the history carries
`timesDeclined` and `lastDecidedAt`, and the prompt says recent and repeated
declines are strong while a lone old one is weak.

## Data model

[`CompanySuggestion`](../prisma/schema.prisma) — deliberately **not** a
`Company`. A declined candidate never becomes one, and creating a stub for every
rejected name would fill the watchlist, dashboard, and what's-next with things
the user said no to sight-unseen.

`verdict` is null until the checklist is answered: an unanswered batch is on
screen, neither added nor declined.

**`nameKey` is the identity**, `slugify` of the name with any trailing
parenthetical stripped. The search likes to qualify a name with the division it
means — *"The Trade Desk (Client Partnerships)"*, *"Spotify (Advertising)"* — and
without stripping, one company keeps two histories and gets re-proposed under its
other spelling. Corporate-suffix variants (*"Evertune AI"* vs *"Evertune"*)
deliberately do **not** merge: folding those would join genuinely different
companies (*"Scale"* and *"Scale AI"*), and a wrong merge suppresses something
the user never declined — worse than a wrong split, which only costs a repeat
question.

The sub-agent is also told not to emit qualified names in the first place; the
stripping is the belt to that braces, and it's what makes old rows work.

## Layers

- [`entities/companies/companySuggestions.ts`](../src/server/entities/companies/companySuggestions.ts) — `recordSuggestions` (at render), `settleSuggestions` (at submit), `listSuggestionHistory` (the read the next search takes), `suggestionKey`.
- [`entities/companies/companySuggestionInputs.ts`](../src/server/entities/companies/companySuggestionInputs.ts) — the decline vocabulary + its labels. The labels are read back to the search verbatim, so they're phrases ("too big"), not enum names.
- [`procedures/registry/commitSuggestions.ts`](../src/server/procedures/registry/commitSuggestions.ts) — the checklist came back: settle every verdict, hand the picks to `runChecklistAdd`, run the memory pass over the declines.
- [`procedures/registry/findCompanies/`](../src/server/procedures/registry/findCompanies/) — records the batch after the sub-agent returns; its loader reads the history back in.

## The checklist

Unchecking a row reveals a chip strip (*too big / too early / wrong space /
already know them / not interested*) plus a free-text box. **All of it is
optional** — forcing a reason on every decline costs more than the signal is
worth, and a bare uncheck still records and still steers.

Two other things on it:

- **A re-steer box.** *"Want a different angle?"* sends plain chat rather than a submission — it's a new request, and Hank turns it into another `find_companies` run with that as the direction. This corrects the *search*, where the chips correct the *results*.
- **A provenance line.** One sentence on how the batch was found (searched vs. worked from knowledge). It's a dedicated `provenance` field on the sub-agent's output schema, not a distillation of its `analysis` scratchpad — the scratchpad is private accounting, and deriving user-facing prose from it with a heuristic is exactly the band-aid this codebase avoids. It's what lets a bad run be diagnosed ("it didn't search") instead of read as a black box.

## Memory

Third instance of commit-writes-memory, after the board and the application page.
What lands is the **pattern, not the roster**: *"turned down three companies over
~5000 people"* is a thesis refinement; *"declined Databricks"* is already a
`CompanySuggestion` row and belongs nowhere else. Governed by the *Declined
company suggestions are thesis signal* section in
[memoryConsolidation.ts](../src/server/subagents/registry/memoryConsolidation.ts).

Only a decline triggers the pass. Keeping what was proposed says nothing new —
the accepted companies are on the watchlist, which the next search already reads.

## The history was recoverable

Every past checklist is still on disk as a `pipeline_widget` block, and a
suggested name with no `Company` is by construction a decline (`createCompanyStubs`
runs for every pick, so even a failed enrich leaves a Company). So the loop
starts with real history rather than empty:
[scripts/migrations/2026-08-05-backfill-company-suggestions.ts](../scripts/migrations/2026-08-05-backfill-company-suggestions.ts),
paired with a gate migration per the [scripts/migrations](../scripts/migrations/README.md)
convention. It needs app code because `nameKey` must come from the same
`suggestionKey` the runtime uses — a hand-rolled equivalent in SQL would drift
and the dedup would silently miss.

## Not built

No declined-history surface — ship the loop first; if suppression works you
rarely need to look at the list. If it turns out you do, the natural home is a
Documents sub-page, not a panel mode.
