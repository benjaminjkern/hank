-- Split the board stance by WHO holds it, so a user's mark stops destroying
-- Hank's rationale. `userVerdict IS NULL` means "I accept Hank's", which is what
-- makes marking a row back to his proposal restore his reason for free.
--
-- Also adds the REVIVED job event: a user overruling an automatic close is a
-- thing that happened, and the commit-time memory pass queries for it.

ALTER TYPE "JobEventType" ADD VALUE IF NOT EXISTS 'REVIVED';

ALTER TABLE "JobInteraction" ADD COLUMN "agentVerdict" "ProposedVerdict";
ALTER TABLE "JobInteraction" ADD COLUMN "agentReason"  TEXT;
ALTER TABLE "JobInteraction" ADD COLUMN "userVerdict"  "ProposedVerdict";
ALTER TABLE "JobInteraction" ADD COLUMN "stanceAt"     TIMESTAMP(3);

-- Every existing stance becomes Hank's proposal with no override on top. A row
-- the user had already moved is indistinguishable: the old write overwrote
-- proposedReason with NULL, so the disagreement it represented is unrecoverable
-- and claiming one would invent a divergence we can't show a reason for.
UPDATE "JobInteraction"
SET "agentVerdict" = "proposedVerdict",
    "agentReason"  = "proposedReason",
    "stanceAt"     = "proposedAt";

ALTER TABLE "JobInteraction" DROP COLUMN "proposedVerdict";
ALTER TABLE "JobInteraction" DROP COLUMN "proposedReason";
ALTER TABLE "JobInteraction" DROP COLUMN "proposedBy";
ALTER TABLE "JobInteraction" DROP COLUMN "proposedAt";

DROP TYPE "ProposedBy";
