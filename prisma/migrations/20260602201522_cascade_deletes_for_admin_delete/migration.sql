-- Wire up cascade behavior so the new /admin/deletions Delete button (hard
-- delete of agent-recommended Company/Job rows) doesn't fail at runtime on any
-- row that has dependents. Prior default was RESTRICT everywhere, which broke
-- the delete the moment a Company had a watchlist entry or a Job had ever
-- been shortlisted.
--
-- CASCADE chain:  Company -> CompanyInteraction
--                 Company -> Job -> JobInteraction -> Event
-- SET NULL on:    MemoryNote.companyId, MemoryNote.jobId  (note content survives)
--                 Contact.companyId                       (recruiter survives)
--                 Opportunity.sourceJobInteractionId      (lead survives)

ALTER TABLE "CompanyInteraction" DROP CONSTRAINT "CompanyInteraction_companyId_fkey";
ALTER TABLE "CompanyInteraction" ADD CONSTRAINT "CompanyInteraction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Job" DROP CONSTRAINT "Job_companyId_fkey";
ALTER TABLE "Job" ADD CONSTRAINT "Job_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryNote" DROP CONSTRAINT "MemoryNote_companyId_fkey";
ALTER TABLE "MemoryNote" ADD CONSTRAINT "MemoryNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MemoryNote" DROP CONSTRAINT "MemoryNote_jobId_fkey";
ALTER TABLE "MemoryNote" ADD CONSTRAINT "MemoryNote_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Contact" DROP CONSTRAINT "Contact_companyId_fkey";
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "JobInteraction" DROP CONSTRAINT "JobInteraction_jobId_fkey";
ALTER TABLE "JobInteraction" ADD CONSTRAINT "JobInteraction_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Event" DROP CONSTRAINT "Event_interactionId_fkey";
ALTER TABLE "Event" ADD CONSTRAINT "Event_interactionId_fkey" FOREIGN KEY ("interactionId") REFERENCES "JobInteraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Opportunity" DROP CONSTRAINT "Opportunity_sourceJobInteractionId_fkey";
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_sourceJobInteractionId_fkey" FOREIGN KEY ("sourceJobInteractionId") REFERENCES "JobInteraction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
