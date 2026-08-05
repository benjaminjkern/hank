// Human-readable renderings of the company close/pause/block reason enums.
// Used for CompanyEvent summary text, company-history one-liners, and any other
// narration that quotes a reason (the notes written here in entities/ and the
// user-facing lines in the walkthrough's narration module).
//
// Each map is keyed on the whole enum, so adding a reason value without giving
// it a label is a compile error rather than a raw SCREAMING_CASE string leaking
// into the UI.
//
// Mirrors entities/jobs/humanJobReasonLabels.ts. The two stay separate because
// the enums do: a company-level "not a match" is a different decision from a
// role-level one, and the labels read differently even where the value overlaps.

import type {
  CompanyBlockReason,
  CompanyPauseReason,
  CompanyCloseReason,
} from "@/generated/prisma/client";

const COMPANY_CLOSE_REASON_LABELS: Record<CompanyCloseReason, string> = {
  NOT_A_MATCH: "not a match",
  LOCATION_MISMATCH: "location mismatch",
  OTHER: "other",
};

export function humanCompanyCloseReason(r: CompanyCloseReason): string {
  return COMPANY_CLOSE_REASON_LABELS[r];
}

const COMPANY_PAUSE_REASON_LABELS: Record<CompanyPauseReason, string> = {
  USER_PAUSED: "paused for now",
  OTHER: "other",
};

export function humanCompanyPauseReason(r: CompanyPauseReason): string {
  return COMPANY_PAUSE_REASON_LABELS[r];
}

const COMPANY_BLOCK_REASON_LABELS: Record<CompanyBlockReason, string> = {
  CANNOT_SCRAPE: "couldn't read the careers page",
  AMBIGUOUS_NAME: "couldn't tell which company's board this is",
  NO_OWN_BOARD: "hires under a parent company, no own board",
  AUTH_WALLED: "the board sits behind a login we can't read",
  OTHER: "other",
};

export function humanCompanyBlockReason(r: CompanyBlockReason): string {
  return COMPANY_BLOCK_REASON_LABELS[r];
}
