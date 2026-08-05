// The shortlist procedure's public surface: the "shortlist roles at a company"
// step of the company ladder. `runShortlist` is the entry — the walkthrough
// company arm's Step 2. It seeds (or re-shows) the shortlist BOARD; the
// negotiation that follows is chat + panel edits over the stance columns, and
// entities/companies/commitShortlist.ts is what ends it.
//
// loadShortlistJobsInput and seedBoardStances are deliberately also imported by
// deep path from the harnesses (the replay script and the regression cap
// check), so they keep their names.

export { runShortlist, type ShortlistArgs } from "./runShortlist";
