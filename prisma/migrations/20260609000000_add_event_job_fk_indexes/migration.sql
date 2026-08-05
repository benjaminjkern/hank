-- FK indexes that Postgres doesn't auto-create. Without these, every
-- Event.findMany / Event.deleteMany scoped by interactionId and every
-- Job.findMany scoped by companyId does a seq scan, which compounds badly
-- under cascade deletes (admin Company delete = N seq scans of Event).
--
-- Also clips a per-tx latency cliff in the shortlist commit path where the
-- 5s interactive-transaction budget is at risk under serial writes.

CREATE INDEX "Job_companyId_idx" ON "Job" ("companyId");

CREATE INDEX "Event_interactionId_idx" ON "Event" ("interactionId");
