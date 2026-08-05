-- Focus is ephemeral now: the deterministic pipeline threads the entity it's
-- working on in-memory for the duration of a turn, widget payloads carry ids
-- across turns, and free chat re-supplies a slug via a tool. So the sticky
-- per-session focus slots + the companion interrupt markers (side-trip / paused-
-- drafting / co-write) no longer exist. DROP COLUMN also drops each column's
-- FK constraint, so no separate DROP CONSTRAINT is needed.

ALTER TABLE "ChatSession" DROP COLUMN "focusedCompanyId";
ALTER TABLE "ChatSession" DROP COLUMN "focusedJobId";
ALTER TABLE "ChatSession" DROP COLUMN "focusedOpportunityId";
ALTER TABLE "ChatSession" DROP COLUMN "pausedWalkthroughCompanyId";
ALTER TABLE "ChatSession" DROP COLUMN "draftingPausedJobId";
ALTER TABLE "ChatSession" DROP COLUMN "coWriteJobId";
