-- Company status redesign.
-- See discussion in chat: rename CompanyStatus to mirror job NEW / SKIPPED-with-
-- reason vocabulary, drop PAUSED, add an explicit CAUGHT_UP state, add
-- skipReason + skipNote to CompanyInteraction, and add LOCATION_MISMATCH to
-- the job SkipReason enum.

-- 1. New CompanySkipReason enum.
CREATE TYPE "CompanySkipReason" AS ENUM ('NOT_A_MATCH', 'LOCATION_MISMATCH', 'NO_MATCHING_ROLES', 'OTHER');

-- 2. Add skipReason + skipNote columns to CompanyInteraction.
ALTER TABLE "CompanyInteraction" ADD COLUMN "skipReason" "CompanySkipReason";
ALTER TABLE "CompanyInteraction" ADD COLUMN "skipNote" TEXT;

-- 3. Replace CompanyStatus enum. Map WATCHING → NEW, PAUSED → CAUGHT_UP,
-- IGNORED → SKIPPED via the USING expression so no row is left with an orphan
-- value. We don't have historical reasons for IGNORED rows, so skipReason
-- stays null for the migrated set.
CREATE TYPE "CompanyStatus_new" AS ENUM ('NEW', 'ACTIVE', 'CAUGHT_UP', 'SKIPPED');
ALTER TABLE "CompanyInteraction" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "CompanyInteraction"
  ALTER COLUMN "status" TYPE "CompanyStatus_new"
  USING (
    CASE "status"::text
      WHEN 'WATCHING' THEN 'NEW'::"CompanyStatus_new"
      WHEN 'PAUSED' THEN 'CAUGHT_UP'::"CompanyStatus_new"
      WHEN 'IGNORED' THEN 'SKIPPED'::"CompanyStatus_new"
      ELSE "status"::text::"CompanyStatus_new"
    END
  );
ALTER TABLE "CompanyInteraction" ALTER COLUMN "status" SET DEFAULT 'NEW';
DROP TYPE "CompanyStatus";
ALTER TYPE "CompanyStatus_new" RENAME TO "CompanyStatus";

-- 4. Add LOCATION_MISMATCH to the job SkipReason enum.
CREATE TYPE "SkipReason_new" AS ENUM (
  'WITHDRAWN',
  'NOT_A_MATCH',
  'LOCATION_MISMATCH',
  'OUTRANKED',
  'OTHER'
);
ALTER TABLE "JobInteraction"
  ALTER COLUMN "skipReason" TYPE "SkipReason_new"
  USING ("skipReason"::text::"SkipReason_new");
DROP TYPE "SkipReason";
ALTER TYPE "SkipReason_new" RENAME TO "SkipReason";
