-- Status / event / skip refactor.
-- See discussion in chat: drop INTERESTED + SEEN + WITHDRAWN statuses; add NEW
-- and SHORTLISTED; consolidate withdrawn into SKIPPED+skipReason=WITHDRAWN;
-- promote skipReason from freeform text to a queryable enum plus skipNote.
-- Add SURFACED and REVIEWED events for audit-trail symmetry.

-- 1. New SkipReason enum.
CREATE TYPE "SkipReason" AS ENUM ('WITHDRAWN', 'NOT_A_MATCH', 'OUTRANKED', 'OTHER');

-- 2. Replace freeform skipReason text with the new enum + skipNote.
ALTER TABLE "JobInteraction" ADD COLUMN "skipNote" TEXT;
ALTER TABLE "JobInteraction" ADD COLUMN "skipReason_new" "SkipReason";
UPDATE "JobInteraction"
SET "skipReason_new" = 'OTHER', "skipNote" = "skipReason"
WHERE "skipReason" IS NOT NULL;
ALTER TABLE "JobInteraction" DROP COLUMN "skipReason";
ALTER TABLE "JobInteraction" RENAME COLUMN "skipReason_new" TO "skipReason";

-- 3. Stamp WITHDRAWN rows with the new skipReason BEFORE we drop the value from
-- the InteractionStatus enum.
UPDATE "JobInteraction" SET "skipReason" = 'WITHDRAWN' WHERE "status"::text = 'WITHDRAWN';

-- 4. Replace InteractionStatus enum. Map SEEN → NEW, INTERESTED → SHORTLISTED,
-- WITHDRAWN → SKIPPED via the USING expression so no row is left with an
-- orphan value.
CREATE TYPE "InteractionStatus_new" AS ENUM (
  'NEW',
  'SHORTLISTED',
  'SKIPPED',
  'APPLIED',
  'RESPONDED',
  'SCREENING',
  'ONSITE',
  'OFFERED',
  'REJECTED'
);
ALTER TABLE "JobInteraction" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "JobInteraction"
  ALTER COLUMN "status" TYPE "InteractionStatus_new"
  USING (
    CASE "status"::text
      WHEN 'SEEN' THEN 'NEW'::"InteractionStatus_new"
      WHEN 'INTERESTED' THEN 'SHORTLISTED'::"InteractionStatus_new"
      WHEN 'WITHDRAWN' THEN 'SKIPPED'::"InteractionStatus_new"
      ELSE "status"::text::"InteractionStatus_new"
    END
  );
ALTER TABLE "JobInteraction" ALTER COLUMN "status" SET DEFAULT 'NEW';
DROP TYPE "InteractionStatus";
ALTER TYPE "InteractionStatus_new" RENAME TO "InteractionStatus";

-- 5. Replace EventType enum. Historical INTERESTED events → SHORTLISTED. Add
-- SURFACED and REVIEWED for the new audit-trail events. WITHDRAWN stays in
-- EventType because it's still a meaningful action (it just resolves to
-- status=SKIPPED + skipReason=WITHDRAWN).
CREATE TYPE "EventType_new" AS ENUM (
  'SURFACED',
  'REVIEWED',
  'SHORTLISTED',
  'SKIPPED',
  'APPLIED',
  'RESPONDED',
  'SCREEN_SCHEDULED',
  'SCREEN_DONE',
  'ONSITE_SCHEDULED',
  'ONSITE_DONE',
  'OFFERED',
  'REJECTED',
  'WITHDRAWN',
  'NOTE'
);
ALTER TABLE "Event"
  ALTER COLUMN "type" TYPE "EventType_new"
  USING (
    CASE "type"::text
      WHEN 'INTERESTED' THEN 'SHORTLISTED'::"EventType_new"
      ELSE "type"::text::"EventType_new"
    END
  );
DROP TYPE "EventType";
ALTER TYPE "EventType_new" RENAME TO "EventType";
