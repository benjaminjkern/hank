-- Freeze a shortlist-board row's GROUP until the user's next chat message:
-- their panel edits write `proposedVerdict` (and relay to Hank on that
-- message), while `placementVerdict` records the group the board draws them
-- under, so a row marked mid-review stays where it sits instead of jumping
-- tier under the cursor. Hank's own moves set both — a divergence therefore
-- always means "the user changed this and hasn't sent a message yet".
--
-- Backfill: every existing stance is already "placed" (nothing is mid-edit
-- across a deploy), so placement starts equal to the live stance.

ALTER TABLE "JobInteraction"
  ADD COLUMN "placementVerdict" "ProposedVerdict";

UPDATE "JobInteraction"
SET "placementVerdict" = "proposedVerdict"
WHERE "proposedVerdict" IS NOT NULL;
