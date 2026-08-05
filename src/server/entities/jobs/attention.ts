// Single source of truth for "what does the user owe action on right now",
// derived from state. Both the dashboard ("Now" bucket) and the whatsNext
// picker ("Immediate" section) import from here so the right panel and Hank
// can't drift on what counts as immediate work — the divergence that left an
// INTERVIEW_DEBRIEF job at a CAUGHT_UP company sitting in the dashboard's "Now"
// pile while whatsNext (company-status-only) never surfaced it to Hank.
//
// See docs/flows.md → "What counts as immediate" and docs/lifecycle.md.

import { JobInteractionStatus } from "@/generated/prisma/client";

// Post-application job statuses where the user personally owes the NEXT move,
// INDEPENDENT of the parent company's status. A company can be CAUGHT_UP
// (nothing left to do on the watchlist arm) while one of its jobs is mid-
// pipeline and waiting on the user — an interview that happened and needs a
// debrief, or an offer that needs a decision. The company-status buckets in
// whatsNext never surface those, so we pull them out as their own job rows.
//
// RESPONDED is deliberately NOT here: it's classified "resting" (the other
// side moved last; any follow-up is soft, not owed). If that judgement
// changes, adding it here flows it to BOTH surfaces in one edit — which is
// the whole point of single-sourcing the set.
//
// WAITING_ON_RESPONSE is deliberately NOT here for the same reason: it's the
// off-ramp a debriefed interview lands on precisely so it STOPS being owed. It
// resurfaces on its own only after a stale stretch — see the stale-waiting tier
// in whatsNext (STALE_WAITING_DAYS), which is time-gated, not owed.
export const OWED_JOB_STATUSES: JobInteractionStatus[] = [
  JobInteractionStatus.INTERVIEW_DEBRIEF, // interview happened — ask how it went
  JobInteractionStatus.OFFERED, // offer in hand — the user owes a decision
];

// There is no revisit-date gating here on purpose: a paused company / deferred
// job stays parked indefinitely until explicitly revived, so nothing
// auto-promotes into the Immediate / Now surfaces on a date.
