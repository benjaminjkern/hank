// What every negotiation panel's payload carries on top of whatever its own
// surface draws — the shortlist board, the discovery list, and one job's
// application. Each is the same shape: Hank proposes, the user amends in place,
// and one commit settles the surface.
//
// The three fields are the whole contract, and they answer three different
// questions the panel chrome and the commit path both need:
//
//   open            — is there still anything to settle? A committed panel is a
//                     record, so its marks stop being editable and its commit
//                     stops being offered.
//   pendingCount    — how much has the user changed since Hank last saw it. The
//                     row-level half is `NegotiationRow.pending`.
//   openThreadCount — how much is still owed a CONVERSATION: something Hank
//                     raised that neither of them has settled.
//
// The last two are deliberately separate, because they route the commit
// differently. Divergence means the user overruled Hank and he should hear about
// it; an open thread means he asked something nobody answered. Only when BOTH
// are zero is "looks good to me" a structured choice rather than a message —
// there is nothing left for him to react to, so the commit skips the LLM turn
// entirely (widgets/dispatchCommitNegotiation.ts).
//
// Every surface implements the pending half; only the application has open
// threads today, and the other two report zero rather than omitting the field —
// a surface that grows one should not have to change this contract to say so.

// How each surface derives its own pending half, since the values being compared
// differ per panel and no single function could own all three:
//
//   shortlist board — `liveVerdict` vs `placementVerdict`  (entities/jobs/boardStance.ts)
//   discovery       — `liveMark(userMark)` vs `liveMark(relayedMark)` (entities/companies/suggestionMark.ts)
//   application     — the live text vs `proposedDrafts`     (entities/jobs/applicationDrafts.ts)
//
// What they DO share is the rule, and it is the reason each compares two
// accessors rather than reading a dirty flag: the baseline is "what Hank last
// saw", so putting a row back where he left it reports nothing at all.
export type NegotiationState = {
  open: boolean;
  pendingCount: number;
  openThreadCount: number;
};

// One row/item of a negotiation panel. `pending` is what draws the accent
// border — reserved app-wide for "you changed this and Hank hasn't seen it",
// which is why no surface may use that colour for anything else.
export type NegotiationRow = {
  pending: boolean;
};
