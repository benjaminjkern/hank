-- Lead-with-roles model: an Opportunity is now the recruiter conversation (the
-- lead), with one or more OpportunityRole rows inside (the pitched/discussed
-- positions). Backfills every existing Opportunity into one role using its
-- current label/companyId/convertedJobInteractionId so the dashboard keeps
-- rendering the same data.

-- CreateEnum
CREATE TYPE "OpportunityRoleStatus" AS ENUM ('PITCHED', 'INTERESTED', 'DECLINED', 'CONVERTED', 'CLOSED');

-- Extend OpportunityEventType with role-context events emitted by the
-- per-role tools (add/triage/convert).
ALTER TYPE "OpportunityEventType" ADD VALUE IF NOT EXISTS 'ROLE_PITCHED';
ALTER TYPE "OpportunityEventType" ADD VALUE IF NOT EXISTS 'ROLE_INTERESTED';
ALTER TYPE "OpportunityEventType" ADD VALUE IF NOT EXISTS 'ROLE_DECLINED';
ALTER TYPE "OpportunityEventType" ADD VALUE IF NOT EXISTS 'ROLE_CONVERTED';
ALTER TYPE "OpportunityEventType" ADD VALUE IF NOT EXISTS 'ROLE_CLOSED';

-- AlterTable: source back-link for "real-company apply triggered this inbound"
-- (Acme apply → Acme recruiter → other Acme roles). Distinct from the Arcadia
-- case where the trigger is an agency posting (no JobInteraction).
ALTER TABLE "Opportunity" ADD COLUMN "sourceJobInteractionId" TEXT;

-- CreateTable
CREATE TABLE "OpportunityRole" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "OpportunityRoleStatus" NOT NULL DEFAULT 'PITCHED',
    "companyId" TEXT,
    "companyName" TEXT,
    "sourceUrl" TEXT,
    "rawContent" TEXT,
    "appliedAt" TIMESTAMP(3),
    "jobInteractionId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpportunityRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpportunityRole_opportunityId_status_idx" ON "OpportunityRole"("opportunityId", "status");
CREATE INDEX "OpportunityRole_companyId_idx" ON "OpportunityRole"("companyId");
CREATE INDEX "OpportunityRole_jobInteractionId_idx" ON "OpportunityRole"("jobInteractionId");

-- AddForeignKey
ALTER TABLE "OpportunityRole" ADD CONSTRAINT "OpportunityRole_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityRole" ADD CONSTRAINT "OpportunityRole_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OpportunityRole" ADD CONSTRAINT "OpportunityRole_jobInteractionId_fkey" FOREIGN KEY ("jobInteractionId") REFERENCES "JobInteraction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_sourceJobInteractionId_fkey" FOREIGN KEY ("sourceJobInteractionId") REFERENCES "JobInteraction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: each existing Opportunity becomes a lead with exactly one role.
-- Status mapping: INBOUND→PITCHED, SCREENING/AWAITING→INTERESTED,
-- CONVERTED→CONVERTED, CLOSED→CLOSED. The role inherits label/companyId/
-- jobInteractionId from the parent Opportunity. After this runs, the parent
-- Opportunity's companyId / convertedJobInteractionId are legacy — kept on
-- the schema for compat; new writes go to the role row.
INSERT INTO "OpportunityRole" (
  "id",
  "opportunityId",
  "label",
  "status",
  "companyId",
  "jobInteractionId",
  "createdAt",
  "updatedAt"
)
SELECT
  -- Synthetic cuid-shaped id seeded from the opportunity id so reruns are
  -- idempotent under "WHERE NOT EXISTS" below (no random component).
  'oprole_' || "id",
  "id",
  "label",
  CASE "status"::text
    WHEN 'INBOUND'   THEN 'PITCHED'::"OpportunityRoleStatus"
    WHEN 'SCREENING' THEN 'INTERESTED'::"OpportunityRoleStatus"
    WHEN 'AWAITING'  THEN 'INTERESTED'::"OpportunityRoleStatus"
    WHEN 'CONVERTED' THEN 'CONVERTED'::"OpportunityRoleStatus"
    WHEN 'CLOSED'    THEN 'CLOSED'::"OpportunityRoleStatus"
    ELSE 'PITCHED'::"OpportunityRoleStatus"
  END,
  "companyId",
  "convertedJobInteractionId",
  "createdAt",
  "updatedAt"
FROM "Opportunity" o
WHERE NOT EXISTS (
  SELECT 1 FROM "OpportunityRole" r WHERE r."opportunityId" = o."id"
);

-- Rewrite parent Opportunity.status = CONVERTED → CLOSED. The "converted" state
-- is now expressed by a role with status=CONVERTED, not by the parent. Leaves
-- CONVERTED in the enum as a tombstone for any future stragglers.
UPDATE "Opportunity" SET "status" = 'CLOSED' WHERE "status" = 'CONVERTED';
