-- Shortlist board (docs/shortlist-board.md): persist the negotiated pre-commit
-- stance per JobInteraction (proposed*) and record which pass closed a row
-- (closeStage), so the board can tier every considered role and corrections can
-- re-enter the pipeline at the right stage.
--
-- All columns nullable, no defaults — additive and safe on live rows.
--
-- Backfill: the only stage reconstructable from existing data is the user's own
-- call — USER_REJECTED (widget un-checks) and WITHDRAWN (user pulled an
-- application) are user acts by definition. Machine closes (NOT_A_MATCH /
-- LOCATION_MISMATCH / OTHER) can't be attributed to prescan vs scan vs
-- shortlist after the fact; they stay NULL, which the board renders as a
-- generic "set aside earlier" group.

CREATE TYPE "ProposedVerdict" AS ENUM ('PICK', 'BORDERLINE', 'PASS');
CREATE TYPE "ProposedBy" AS ENUM ('HANK', 'USER');
CREATE TYPE "CloseStage" AS ENUM ('PRE_SCAN', 'SCAN', 'SHORTLIST', 'USER');

ALTER TABLE "JobInteraction"
  ADD COLUMN "proposedVerdict" "ProposedVerdict",
  ADD COLUMN "proposedReason" TEXT,
  ADD COLUMN "proposedBy" "ProposedBy",
  ADD COLUMN "proposedAt" TIMESTAMP(3),
  ADD COLUMN "closeStage" "CloseStage";

UPDATE "JobInteraction"
SET "closeStage" = 'USER'
WHERE "closeReason" IN ('USER_REJECTED', 'WITHDRAWN');
