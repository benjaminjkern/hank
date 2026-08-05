-- Collapse OpportunityRole into JobInteraction. Each existing role becomes a
-- regular Job + JobInteraction linked back to its parent Opportunity via the
-- new JobInteraction.opportunityId FK. Job.companyId becomes nullable so the
-- agency-pitched roles (undisclosed hiring company) survive; the human-readable
-- fallback lives on the new Job.companyName column.
--
-- New enum values PITCHED (InteractionStatus) and OPEN (OpportunityStatus) are
-- added in the predecessor migration (20260601180000_collapse_opportunity_roles_pre).
-- Postgres won't let us reference them in INSERTs in the same transaction they
-- were added — hence the split.

-- ---------------------------------------------------------------------------
-- 1. Additive schema changes
-- ---------------------------------------------------------------------------

-- Job.companyId becomes nullable; new Job.companyName carries the
-- human-readable fallback when companyId is null.
ALTER TABLE "Job" ALTER COLUMN "companyId" DROP NOT NULL;
ALTER TABLE "Job" ADD COLUMN "companyName" TEXT;

-- The new role↔lead link. PITCHED-status JobInteractions always have this set.
ALTER TABLE "JobInteraction" ADD COLUMN "opportunityId" TEXT;
ALTER TABLE "JobInteraction" ADD CONSTRAINT "JobInteraction_opportunityId_fkey"
  FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "JobInteraction_opportunityId_idx" ON "JobInteraction"("opportunityId");

-- ---------------------------------------------------------------------------
-- 2. Backfill: OpportunityRole → Job + JobInteraction (+ optional APPLIED event)
-- ---------------------------------------------------------------------------

-- 2a. For roles already CONVERTED (have a jobInteractionId): just link the
-- existing JobInteraction back to the parent Opportunity. No new Job needed.
UPDATE "JobInteraction" ji
SET "opportunityId" = r."opportunityId"
FROM "OpportunityRole" r
WHERE r."jobInteractionId" = ji."id"
  AND r."status" = 'CONVERTED';

-- 2b. For all other roles (PITCHED, INTERESTED, DECLINED, CLOSED): create a
-- new Job + JobInteraction. Synthetic ids prefixed so they're recognizable as
-- migration-backfilled and re-runs would no-op via NOT EXISTS guards.
INSERT INTO "Job" (
  "id",
  "companyId",
  "companyName",
  "title",
  "sourceUrl",
  "rawContent",
  "createdAt"
)
SELECT
  'job_' || r."id",
  r."companyId",
  r."companyName",
  r."label",
  r."sourceUrl",
  r."rawContent",
  r."createdAt"
FROM "OpportunityRole" r
WHERE r."status" <> 'CONVERTED'
  AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = 'job_' || r."id");

INSERT INTO "JobInteraction" (
  "id",
  "userId",
  "jobId",
  "status",
  "skipReason",
  "skipNote",
  "notes",
  "opportunityId",
  "createdAt",
  "updatedAt"
)
SELECT
  'ji_' || r."id",
  o."userId",
  'job_' || r."id",
  -- Role.status → JobInteraction.status. appliedAt overrides further below.
  CASE r."status"::text
    WHEN 'PITCHED'    THEN 'PITCHED'::"InteractionStatus"
    -- Conservative: INTERESTED → PITCHED so the agent re-triages. The note
    -- below preserves the original signal.
    WHEN 'INTERESTED' THEN 'PITCHED'::"InteractionStatus"
    WHEN 'DECLINED'   THEN 'SKIPPED'::"InteractionStatus"
    WHEN 'CLOSED'     THEN 'SKIPPED'::"InteractionStatus"
    ELSE 'PITCHED'::"InteractionStatus"
  END,
  CASE r."status"::text
    WHEN 'DECLINED' THEN 'NOT_A_MATCH'::"SkipReason"
    WHEN 'CLOSED'   THEN 'OTHER'::"SkipReason"
    ELSE NULL
  END,
  CASE r."status"::text
    WHEN 'CLOSED' THEN r."notes"
    ELSE NULL
  END,
  CASE r."status"::text
    WHEN 'INTERESTED' THEN COALESCE(r."notes" || E'\n', '') || '[migrated from INTERESTED — re-triage]'
    ELSE r."notes"
  END,
  r."opportunityId",
  r."createdAt",
  r."updatedAt"
FROM "OpportunityRole" r
JOIN "Opportunity" o ON o."id" = r."opportunityId"
WHERE r."status" <> 'CONVERTED'
  AND NOT EXISTS (SELECT 1 FROM "JobInteraction" ji WHERE ji."id" = 'ji_' || r."id");

-- 2c. appliedAt: any role with appliedAt set bumps the new JobInteraction to
-- APPLIED and writes an Event(APPLIED) on the JobInteraction's timeline. This
-- preserves the "LinkedIn-applied-first" case from the old OpportunityRole
-- semantics.
UPDATE "JobInteraction" ji
SET "status" = 'APPLIED'::"InteractionStatus"
FROM "OpportunityRole" r
WHERE ji."id" = 'ji_' || r."id"
  AND r."appliedAt" IS NOT NULL
  AND r."status" <> 'CONVERTED';

INSERT INTO "Event" (
  "id",
  "interactionId",
  "type",
  "occurredAt",
  "notes",
  "source",
  "createdAt"
)
SELECT
  'evt_apply_' || r."id",
  'ji_' || r."id",
  'APPLIED'::"EventType",
  r."appliedAt",
  'migrated from OpportunityRole.appliedAt',
  'USER_LOGGED'::"EventSource",
  r."appliedAt"
FROM "OpportunityRole" r
WHERE r."appliedAt" IS NOT NULL
  AND r."status" <> 'CONVERTED'
  AND NOT EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = 'evt_apply_' || r."id");

-- ---------------------------------------------------------------------------
-- 3. Rename OpportunityStatus.INBOUND → OPEN on existing rows
-- ---------------------------------------------------------------------------
UPDATE "Opportunity" SET "status" = 'OPEN'::"OpportunityStatus" WHERE "status" = 'INBOUND';

-- ---------------------------------------------------------------------------
-- 4. Drop deprecated Opportunity columns + OpportunityRole table + enum
-- ---------------------------------------------------------------------------

ALTER TABLE "Opportunity" DROP CONSTRAINT IF EXISTS "Opportunity_companyId_fkey";
ALTER TABLE "Opportunity" DROP CONSTRAINT IF EXISTS "Opportunity_convertedJobInteractionId_fkey";
ALTER TABLE "Opportunity" DROP COLUMN IF EXISTS "companyId";
ALTER TABLE "Opportunity" DROP COLUMN IF EXISTS "convertedJobInteractionId";

DROP TABLE "OpportunityRole";
DROP TYPE "OpportunityRoleStatus";

-- Note: OpportunityStatus.INBOUND stays in the Postgres enum as a dead value.
-- Postgres can't safely drop an enum value referenced by historical row data;
-- the TS-side default and tooling stop writing it (see prisma/schema.prisma
-- comment marking it a legacy tombstone). Same for the legacy ROLE_* values
-- on OpportunityEventType — kept so historical OpportunityEvent rows still
-- render, no new writes.
