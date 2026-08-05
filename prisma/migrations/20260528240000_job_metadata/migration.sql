-- Add structured metadata to Job so the agent can pre-filter by title +
-- location + comp before loading rawContent into context. Populated by the
-- ATS parsers and the generic LLM scrape; nullable for backfill / sources
-- that don't provide it.
ALTER TABLE "Job" ADD COLUMN "location" TEXT;
ALTER TABLE "Job" ADD COLUMN "department" TEXT;
ALTER TABLE "Job" ADD COLUMN "compensation" TEXT;
ALTER TABLE "Job" ADD COLUMN "employmentType" TEXT;
