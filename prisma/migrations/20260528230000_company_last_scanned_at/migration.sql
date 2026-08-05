-- Add lastScannedAt to CompanyInteraction so the agent can decide whether a
-- CAUGHT_UP company is due for a re-scan. Backfill from the most-recent Job
-- created at each company (best proxy we have for past scrape activity; scans
-- that produced no new jobs are invisible to this backfill, but next scan
-- will write the column properly).

ALTER TABLE "CompanyInteraction" ADD COLUMN "lastScannedAt" TIMESTAMP(3);

UPDATE "CompanyInteraction" ci
SET "lastScannedAt" = sub.last_job_created_at
FROM (
  SELECT "companyId", MAX("createdAt") AS last_job_created_at
  FROM "Job"
  GROUP BY "companyId"
) sub
WHERE ci."companyId" = sub."companyId";
