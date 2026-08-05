-- Backfill: CompanyInteractions currently in ACTIVE that have no SHORTLISTED
-- jobs at the company (for that user) get demoted to READY. These are rows
-- where add_to_watchlist's old behavior marked the company ACTIVE post-
-- prescan — but the user never engaged enough to actually shortlist anything.
-- Under the new semantics, those are READY, not ACTIVE.
--
-- Rows with at least one SHORTLISTED job are genuinely mid-walkthrough; leave
-- them ACTIVE. The window between bumpToScanned and a SHORTLISTED commit is
-- seconds, so the risk of demoting a real mid-walkthrough row is minimal.

UPDATE "CompanyInteraction" ci
SET status = 'READY'
WHERE status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1
    FROM "JobInteraction" ji
    JOIN "Job" j ON j.id = ji."jobId"
    WHERE ji."userId" = ci."userId"
      AND j."companyId" = ci."companyId"
      AND ji.status = 'SHORTLISTED'
  );
