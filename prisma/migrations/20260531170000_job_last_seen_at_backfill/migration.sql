-- Backfill Job.lastSeenAt for rows that pre-date the column. Each job
-- inherits the most recent lastScannedAt across CompanyInteraction rows for
-- its parent company. This makes existing jobs count as "present in the most
-- recent scan" for the dashboard's recentJobCount filter; once any company
-- is re-scanned, search_jobs writes a fresh lastSeenAt and the data
-- self-corrects. Jobs at companies that have never been scanned (e.g. manual
-- create_job entries) remain NULL — they're not from a scrape and shouldn't
-- count toward "jobs scanned".
UPDATE "Job"
SET "lastSeenAt" = ci."lastScannedAt"
FROM (
  SELECT "companyId", MAX("lastScannedAt") AS "lastScannedAt"
  FROM "CompanyInteraction"
  WHERE "lastScannedAt" IS NOT NULL
  GROUP BY "companyId"
) ci
WHERE "Job"."companyId" = ci."companyId"
  AND "Job"."lastSeenAt" IS NULL;
