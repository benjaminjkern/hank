-- Move the APPLYING rows that were never applying.
--
-- Separate from the ADD VALUE migration on purpose: Postgres refuses to USE a
-- new enum value in the transaction that added it, and Prisma runs each
-- migration in its own transaction.
--
-- An open board is the honest tell for "it's the user's turn" — the same
-- predicate `onBoardWhere()` uses. APPLYING rows without one stay APPLYING:
-- their shortlist was committed, which is what the status now means.
UPDATE "CompanyInteraction" ci
SET status = 'SHORTLISTING'
WHERE ci.status = 'APPLYING'
  AND EXISTS (
    SELECT 1
    FROM "JobInteraction" ji
    JOIN "Job" j ON j.id = ji."jobId"
    WHERE ji."userId" = ci."userId"
      AND j."companyId" = ci."companyId"
      AND (
        ji."agentVerdict" IS NOT NULL
        OR ji."userVerdict" IS NOT NULL
        OR ji."placementVerdict" IS NOT NULL
      )
  );
