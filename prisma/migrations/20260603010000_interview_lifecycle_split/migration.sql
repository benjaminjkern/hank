-- Collapse SCREENING / ONSITE into a single INTERVIEW_SCHEDULED / INTERVIEW_DEBRIEF
-- pair on InteractionStatus, and add matching INTERVIEW_SCHEDULED /
-- INTERVIEW_HAPPENED events. The legacy enum values stay because Postgres
-- can't drop enum values that are referenced by historical rows; EVENT_TO_STATUS
-- in interactions.ts remaps the legacy events to the new statuses.

ALTER TYPE "InteractionStatus" ADD VALUE IF NOT EXISTS 'INTERVIEW_SCHEDULED';
ALTER TYPE "InteractionStatus" ADD VALUE IF NOT EXISTS 'INTERVIEW_DEBRIEF';

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'INTERVIEW_SCHEDULED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'INTERVIEW_HAPPENED';

-- Backfill: every existing SCREENING / ONSITE row → INTERVIEW_SCHEDULED.
-- The lazy-flip helper on read paths will promote rows whose latest interview
-- event's occurredAt is in the past to INTERVIEW_DEBRIEF on next access.
-- Wrapped in a DO block because Postgres won't let an ALTER TYPE ADD VALUE
-- and a query that *uses* that new value run in the same transaction; running
-- the UPDATE in a separate statement after the ALTERs above is fine.
UPDATE "JobInteraction"
SET status = 'INTERVIEW_SCHEDULED'
WHERE status IN ('SCREENING', 'ONSITE');
