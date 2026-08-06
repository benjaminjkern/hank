-- A declined suggestion records the name and nothing else. The structured
-- "why not" the checklist offered never captured a single row: the reason a
-- batch was wrong is one sentence in chat, which reaches the next search as its
-- direction and reaches memory through the ordinary consolidation pass.

ALTER TABLE "CompanySuggestion"
  DROP COLUMN "declineReason",
  DROP COLUMN "declineNote";

DROP TYPE "CompanySuggestionDeclineReason";
