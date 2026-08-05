-- Add draftingPausedJobId to ChatSession. Set by the walkthrough runner when
-- a turn is user-stopped mid-drafting (the state-machine pass aborts inside
-- runJobArm, or the agent loop stops while focusedJobId is set). While this
-- column equals focusedJobId, runJobArm short-circuits and emits a
-- `resume_drafting` widget instead of resuming the cut-off draft — the user
-- decides explicitly whether to continue or move on. Cleared by
-- mark_job_applied / skip_job / defer_job on the matching jobId, by any
-- focus shift via the picker / company_walkthrough, and by the user's
-- widget submission (yes resumes; no clears the marker + focus).
ALTER TABLE "ChatSession" ADD COLUMN "draftingPausedJobId" TEXT;
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_draftingPausedJobId_fkey"
  FOREIGN KEY ("draftingPausedJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
