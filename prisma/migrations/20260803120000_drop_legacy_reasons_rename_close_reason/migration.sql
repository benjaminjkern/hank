-- Drop every LEGACY tombstone value from the four reason enums, and rename the
-- job one from `CloseReason` to `JobCloseReason` -- the bare name read like the
-- shared/generic reason enum when it only ever applied to jobs, next to a
-- `CompanyCloseReason` that says which level it belongs to. The rename rides
-- along for free: each enum is being recreated anyway, so the new type is just
-- created under the new name.
--
-- Backfill first: 16 rows across prod carry a retired value (verified
-- 2026-08-03). All 16 already have a descriptive freeform *Note, so the enum
-- label carries no information the row loses -- they collapse to OTHER.
--   CompanyCloseReason.NO_MATCHING_ROLES   2
--   CompanyPauseReason.NO_ROLES_VIABLE_NOW 2
--   CompanyPauseReason.AWAITING_SIGNAL     1
--   JobDeferReason.NEEDS_PREP              6
--   JobDeferReason.TIMING_USER             5
-- The other seven values (CompanyCloseReason.CANNOT_SCRAPE,
-- CompanyPauseReason.STRUCTURAL_FLIP_POSSIBLE, CloseReason.OUTRANKED,
-- JobDeferReason.WAITING_FOR_REFERRAL / TIMING_EXTERNAL / IN_OTHER_ROUNDS /
-- SHORTLIST_PASSED_OVER) have never had a backing row.
--
-- Postgres has no DROP VALUE, so each enum is recreated: rename old -> create
-- new with the surviving labels -> retype the column through text -> drop old.
-- Every column involved is nullable with no DEFAULT, so no default needs
-- dropping and re-adding.

UPDATE "CompanyInteraction"
SET "closeReason" = 'OTHER'
WHERE "closeReason" IN ('NO_MATCHING_ROLES', 'CANNOT_SCRAPE');

UPDATE "CompanyInteraction"
SET "pauseReason" = 'OTHER'
WHERE "pauseReason" IN ('STRUCTURAL_FLIP_POSSIBLE', 'NO_ROLES_VIABLE_NOW', 'AWAITING_SIGNAL');

UPDATE "JobInteraction"
SET "closeReason" = 'OTHER'
WHERE "closeReason" = 'OUTRANKED';

UPDATE "JobInteraction"
SET "deferReason" = 'OTHER'
WHERE "deferReason" IN ('WAITING_FOR_REFERRAL', 'TIMING_EXTERNAL', 'TIMING_USER', 'IN_OTHER_ROUNDS', 'NEEDS_PREP', 'SHORTLIST_PASSED_OVER');

ALTER TYPE "CompanyCloseReason" RENAME TO "CompanyCloseReason_old";
CREATE TYPE "CompanyCloseReason" AS ENUM ('NOT_A_MATCH', 'LOCATION_MISMATCH', 'OTHER');
ALTER TABLE "CompanyInteraction"
  ALTER COLUMN "closeReason" TYPE "CompanyCloseReason"
  USING "closeReason"::text::"CompanyCloseReason";
DROP TYPE "CompanyCloseReason_old";

ALTER TYPE "CompanyPauseReason" RENAME TO "CompanyPauseReason_old";
CREATE TYPE "CompanyPauseReason" AS ENUM ('USER_PAUSED', 'OTHER');
ALTER TABLE "CompanyInteraction"
  ALTER COLUMN "pauseReason" TYPE "CompanyPauseReason"
  USING "pauseReason"::text::"CompanyPauseReason";
DROP TYPE "CompanyPauseReason_old";

CREATE TYPE "JobCloseReason" AS ENUM ('WITHDRAWN', 'NOT_A_MATCH', 'LOCATION_MISMATCH', 'USER_REJECTED', 'OTHER');
ALTER TABLE "JobInteraction"
  ALTER COLUMN "closeReason" TYPE "JobCloseReason"
  USING "closeReason"::text::"JobCloseReason";
DROP TYPE "CloseReason";

ALTER TYPE "JobDeferReason" RENAME TO "JobDeferReason_old";
CREATE TYPE "JobDeferReason" AS ENUM ('OUTRANKED', 'OTHER');
ALTER TABLE "JobInteraction"
  ALTER COLUMN "deferReason" TYPE "JobDeferReason"
  USING "deferReason"::text::"JobDeferReason";
DROP TYPE "JobDeferReason_old";
