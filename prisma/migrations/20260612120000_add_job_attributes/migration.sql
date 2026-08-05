-- Provider-specific extras from the ATS list/detail response that don't earn a
-- promoted column. Flat string→string map fed to the prescan / shortlist agents
-- alongside location/department/compensation/employmentType. Nullable, additive.
ALTER TABLE "Job" ADD COLUMN "attributes" JSONB;
