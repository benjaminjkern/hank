-- Add FK constraints (ON DELETE SET NULL) to the three sticky focus slots on
-- ChatSession: focusedCompanyId / focusedJobId / focusedOpportunityId. These
-- columns predate this migration as plain TEXT with no FK, so a hard-deleted
-- Company / Job / Opportunity left a *dangling* focus pointer that the right
-- panel kept trying to render (buildFocusEvents picked the panel mode off the
-- raw id even when the view failed to load) and that set_focus({companyId})
-- could not override. SetNull mirrors the pausedWalkthroughCompanyId /
-- draftingPausedJobId / coWriteJobId slots, which are FK + SetNull for the
-- same reason.

-- Null out any currently-dangling pointers first so ADD CONSTRAINT can't fail
-- on a pre-existing orphan (there are none at authoring time, but a delete
-- could land between now and apply).
UPDATE "ChatSession" cs SET "focusedCompanyId" = NULL
  WHERE "focusedCompanyId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Company" c WHERE c.id = cs."focusedCompanyId");
UPDATE "ChatSession" cs SET "focusedJobId" = NULL
  WHERE "focusedJobId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j.id = cs."focusedJobId");
UPDATE "ChatSession" cs SET "focusedOpportunityId" = NULL
  WHERE "focusedOpportunityId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Opportunity" o WHERE o.id = cs."focusedOpportunityId");

ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_focusedCompanyId_fkey"
  FOREIGN KEY ("focusedCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_focusedJobId_fkey"
  FOREIGN KEY ("focusedJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_focusedOpportunityId_fkey"
  FOREIGN KEY ("focusedOpportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
