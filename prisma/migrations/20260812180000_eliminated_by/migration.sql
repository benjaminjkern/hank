-- Which pass proposed passing on a role.
--
-- Arrives with the change that makes the automatic passes STANCE a role rather
-- than close it: nothing changes status until the shortlist is committed, so the
-- board's closing pile is now rows carrying a PASS stance, and this is what
-- orders it. A role the ranker itself passed on got further than one the full
-- read eliminated, which got further than one the metadata pass never opened —
-- and that is the only fit signal those rows have, since a role dropped before
-- the read never gets a matchBucket.
--
-- Nullable with no backfill on purpose. It qualifies a live stance, and every
-- stance that predates this is either already committed (so the row carries a
-- real status and needs no proposal metadata) or belongs to one of the two open
-- boards, whose already-closed rows stay closed — reconstructing which pass
-- closed them would mean the JobEvent-timestamp comparison this change exists to
-- delete.
CREATE TYPE "EliminatedBy" AS ENUM ('PRE_SCAN', 'SCAN', 'SHORTLIST');

ALTER TABLE "JobInteraction" ADD COLUMN "eliminatedBy" "EliminatedBy";
