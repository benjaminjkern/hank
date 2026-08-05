-- Branch 2: application-drafting decider + chat co-writing.
-- ChatSession.coWriteJobId: active co-write target (FK to Job, SET NULL on delete).
-- JobInteraction.draftDecision: cached per-job decider verdicts (JSON).

ALTER TABLE "ChatSession" ADD COLUMN "coWriteJobId" TEXT;

ALTER TABLE "JobInteraction" ADD COLUMN "draftDecision" JSONB;

ALTER TABLE "ChatSession"
  ADD CONSTRAINT "ChatSession_coWriteJobId_fkey"
  FOREIGN KEY ("coWriteJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
