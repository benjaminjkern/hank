-- Company enrichment provenance flags (Phase 2). Additive + nullable, so this
-- is safe to apply ahead of the branch merge: existing code never selects them.
ALTER TABLE "Company" ADD COLUMN "basicInfoHuntedAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "atsVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "logoVerifiedAt" TIMESTAMP(3);
