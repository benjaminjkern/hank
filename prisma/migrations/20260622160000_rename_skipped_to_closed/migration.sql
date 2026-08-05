-- Rename the "user/agent passed on it" status from SKIPPED to CLOSED so the
-- code matches the user-facing word (Hank already says "close" / "closed").
--
-- COLLISION: InteractionStatus already had a CLOSED value meaning "the posting
-- came down off the board on its own" (system-set, see Job.closedAt). To free
-- the CLOSED name for the user-close action we first rename that existing value
-- to DELISTED, THEN rename SKIPPED -> CLOSED. Order is load-bearing — doing it
-- the other way errors with "enum label CLOSED already exists".
--
-- All of these are METADATA-ONLY (no table rewrite, no data migration):
--   * ALTER TYPE ... RENAME VALUE preserves the enum's position, so existing
--     rows pick up the new label automatically (precedent:
--     20260601150000_rename_reviewed_to_scanned).
--   * ALTER TYPE ... RENAME TO renames the enum type in place.
--   * ALTER TABLE ... RENAME COLUMN renames the column in place (precedent:
--     20260528210000_shortlist_refactor).
--
-- NOTE: these statements are NOT wrapped in an explicit transaction, matching
-- the prior RENAME VALUE migration (some Postgres versions disallow ALTER TYPE
-- ... RENAME VALUE inside a transaction block).

-- 1. Free the CLOSED name: the existing "posting taken down" value -> DELISTED.
--    MUST come before the SKIPPED -> CLOSED renames below.
ALTER TYPE "InteractionStatus" RENAME VALUE 'CLOSED' TO 'DELISTED';

-- 2. SKIPPED -> CLOSED on all three enums that carry the literal. The status
--    and its event keep parallel naming, so EventType moves too.
ALTER TYPE "InteractionStatus" RENAME VALUE 'SKIPPED' TO 'CLOSED';
ALTER TYPE "CompanyStatus"     RENAME VALUE 'SKIPPED' TO 'CLOSED';
ALTER TYPE "EventType"         RENAME VALUE 'SKIPPED' TO 'CLOSED';

-- 3. Reason enum types -> Close*.
ALTER TYPE "SkipReason"        RENAME TO "CloseReason";
ALTER TYPE "CompanySkipReason" RENAME TO "CompanyCloseReason";

-- 4. Reason / note columns -> close*.
ALTER TABLE "JobInteraction"     RENAME COLUMN "skipReason" TO "closeReason";
ALTER TABLE "JobInteraction"     RENAME COLUMN "skipNote"   TO "closeNote";
ALTER TABLE "CompanyInteraction" RENAME COLUMN "skipReason" TO "closeReason";
ALTER TABLE "CompanyInteraction" RENAME COLUMN "skipNote"   TO "closeNote";
