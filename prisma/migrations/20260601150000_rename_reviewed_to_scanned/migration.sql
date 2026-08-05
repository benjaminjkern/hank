-- Rename REVIEWED → SCANNED in both InteractionStatus and EventType.
-- REVIEWED was ambiguous (read as "the user reviewed it" rather than "Hank
-- read the description"). SCANNED is clearer: it's the agent's action.
-- The status and event keep their parallel naming (cf. SHORTLISTED /
-- SKIPPED / APPLIED — all match the event that causes the transition).
--
-- ALTER TYPE RENAME VALUE preserves position in the enum, so existing rows
-- pick up the new name automatically with no data migration.

ALTER TYPE "InteractionStatus" RENAME VALUE 'REVIEWED' TO 'SCANNED';
ALTER TYPE "EventType" RENAME VALUE 'REVIEWED' TO 'SCANNED';
