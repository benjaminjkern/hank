-- Company-level close-summary label on JobInteraction: the "they're all ___"
-- phrase the walkthrough tallies across a company's closes when it surfaced
-- nothing. Nullable; no backfill (old rows fall back to the generic summary).
ALTER TABLE "JobInteraction" ADD COLUMN "closeSummaryLabel" TEXT;
