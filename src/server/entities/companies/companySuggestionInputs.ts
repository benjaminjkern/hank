// The "why not" reasons the company checklist OFFERS when the user declines a
// suggestion, and their human labels.
//
// Every value is offered — unlike the block-reason list next door, there's no
// curated subset here, because the user picks these directly rather than an
// agent choosing among them. Mirrors entities/companies/companyInteractionInputs.ts.

export const COMPANY_SUGGESTION_DECLINE_REASONS = [
  "TOO_LARGE",
  "TOO_EARLY",
  "WRONG_DOMAIN",
  "ALREADY_KNOWN",
  "NOT_INTERESTED",
  "OTHER",
] as const;

export type CompanySuggestionDeclineReasonName =
  (typeof COMPANY_SUGGESTION_DECLINE_REASONS)[number];

// What the chips say. Written as the user's own voice, since they're the one
// clicking — and read back to the search verbatim, so they have to be a
// sentence the model can weigh, not an enum name.
export const SUGGESTION_DECLINE_LABELS: Record<
  CompanySuggestionDeclineReasonName,
  string
> = {
  TOO_LARGE: "too big",
  TOO_EARLY: "too early-stage",
  WRONG_DOMAIN: "wrong space",
  ALREADY_KNOWN: "already know them",
  NOT_INTERESTED: "not interested",
  OTHER: "other",
};
