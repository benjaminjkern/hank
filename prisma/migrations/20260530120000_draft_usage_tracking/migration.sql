-- Track when the user (not the agent) edited or copied a draft, so we can
-- wipe untouched drafts when APPLIED is logged. Null = never used.
ALTER TABLE "JobInteraction" ADD COLUMN "coverLetterUsedAt" TIMESTAMP(3);
ALTER TABLE "JobInteraction" ADD COLUMN "shortAnswersUsedAt" JSONB;

-- New event type for the timeline: DRAFT_USED with notes describing what was
-- touched ("edited cover letter", "copied short answer #2", etc).
ALTER TYPE "EventType" ADD VALUE 'DRAFT_USED';
