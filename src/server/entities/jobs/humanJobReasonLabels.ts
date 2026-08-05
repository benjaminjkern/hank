// Human-readable renderings of the job close/defer reason enums. Used for the
// notes on batch-close events, and any other narration that quotes a reason
// (including the user-facing lines in the walkthrough's narration module).
//
// Each map is keyed on the whole enum, so adding a reason value without giving
// it a label is a compile error rather than a raw SCREAMING_CASE string leaking
// into the UI.
//
// Mirrors entities/companies/humanCompanyReasonLabels.ts. The two stay separate
// because the enums do: a role-level "not a match" is a different decision from
// a company-level one, and the labels read differently even where the value
// overlaps.

import type { JobCloseReason, JobDeferReason } from "@/generated/prisma/client";

const JOB_CLOSE_REASON_LABELS: Record<JobCloseReason, string> = {
  WITHDRAWN: "withdrawn",
  NOT_A_MATCH: "not a match",
  LOCATION_MISMATCH: "location mismatch",
  USER_REJECTED: "rejected during shortlist",
  OTHER: "other",
};

export function humanJobCloseReason(r: JobCloseReason): string {
  return JOB_CLOSE_REASON_LABELS[r];
}

const JOB_DEFER_REASON_LABELS: Record<JobDeferReason, string> = {
  OUTRANKED: "outranked by other roles",
  OTHER: "other",
};

export function humanJobDeferReason(r: JobDeferReason): string {
  return JOB_DEFER_REASON_LABELS[r];
}
