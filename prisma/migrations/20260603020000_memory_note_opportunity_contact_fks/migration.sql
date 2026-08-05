-- Add denormalized FK columns on MemoryNote for opportunities/* and contacts/*
-- paths. Matches the existing companyId/jobId pattern: SetNull on delete so
-- note content survives admin hard-delete of the linked entity (path-addressed;
-- the FK is just an index hint that powers cascade behavior).

ALTER TABLE "MemoryNote" ADD COLUMN "opportunityId" TEXT;
ALTER TABLE "MemoryNote" ADD COLUMN "contactId" TEXT;

ALTER TABLE "MemoryNote"
  ADD CONSTRAINT "MemoryNote_opportunityId_fkey"
  FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MemoryNote"
  ADD CONSTRAINT "MemoryNote_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
