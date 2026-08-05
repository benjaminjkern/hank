-- Drop 14 zero-backing-row LEGACY enum tombstones across 4 enums. Each value
-- was verified to have 0 rows in prod before this was authored, so the USING
-- casts can never hit a stranded value. Postgres has no ALTER TYPE ... DROP
-- VALUE, so each enum is recreated: rename old -> create new (surviving values)
-- -> re-cast the column(s) -> drop old.

-- JobInteractionStatus: drop SCREENING, ONSITE
ALTER TYPE "JobInteractionStatus" RENAME TO "JobInteractionStatus_old";
CREATE TYPE "JobInteractionStatus" AS ENUM ('PITCHED', 'NEW', 'SCANNED', 'SHORTLISTED', 'CLOSED', 'DEFERRED', 'APPLIED', 'RESPONDED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_DEBRIEF', 'WAITING_ON_RESPONSE', 'OFFERED', 'REJECTED', 'DELISTED');
ALTER TABLE "JobInteraction" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "JobInteraction" ALTER COLUMN "status" TYPE "JobInteractionStatus" USING ("status"::text::"JobInteractionStatus");
ALTER TABLE "JobInteraction" ALTER COLUMN "status" SET DEFAULT 'NEW';
DROP TYPE "JobInteractionStatus_old";

-- JobEventType (physical type "EventType"): drop SCREEN_SCHEDULED, SCREEN_DONE,
-- ONSITE_SCHEDULED, ONSITE_DONE (keeps DRAFT_USED — it has backing rows).
ALTER TYPE "EventType" RENAME TO "EventType_old";
CREATE TYPE "EventType" AS ENUM ('SURFACED', 'SCANNED', 'SHORTLISTED', 'CLOSED', 'APPLIED', 'RESPONDED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_HAPPENED', 'AWAITING_RESPONSE', 'OFFERED', 'REJECTED', 'WITHDRAWN', 'DEFERRED', 'DELISTED', 'DRAFT_USED', 'NOTE');
ALTER TABLE "Event" ALTER COLUMN "type" TYPE "EventType" USING ("type"::text::"EventType");
DROP TYPE "EventType_old";

-- OpportunityStatus: drop INBOUND, CONVERTED (keeps SCREENING — a live value).
ALTER TYPE "OpportunityStatus" RENAME TO "OpportunityStatus_old";
CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'SCREENING', 'AWAITING', 'CLOSED');
ALTER TABLE "Opportunity" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Opportunity" ALTER COLUMN "status" TYPE "OpportunityStatus" USING ("status"::text::"OpportunityStatus");
ALTER TABLE "Opportunity" ALTER COLUMN "status" SET DEFAULT 'OPEN';
DROP TYPE "OpportunityStatus_old";

-- OpportunityEventType: drop CONVERTED + the ROLE_* family (keeps INBOUND_RECEIVED).
ALTER TYPE "OpportunityEventType" RENAME TO "OpportunityEventType_old";
CREATE TYPE "OpportunityEventType" AS ENUM ('INBOUND_RECEIVED', 'CALL_SCHEDULED', 'CALL_HAPPENED', 'NEXT_STEP_RECEIVED', 'STATUS_CHANGED', 'CLOSED', 'NOTE');
ALTER TABLE "OpportunityEvent" ALTER COLUMN "type" TYPE "OpportunityEventType" USING ("type"::text::"OpportunityEventType");
DROP TYPE "OpportunityEventType_old";
