-- Remove CompanyStatus.SCANNING.
--
-- It never described a company for longer than a few milliseconds: the picker
-- set it on entry, and the walkthrough's own markCompanyReady overwrote it
-- before the scan it was named for actually started. A company now reads READY
-- for the whole scan and flips to SHORTLISTING when the board is up, which is
-- the only stretch where the next move is the user's.
--
-- Postgres cannot drop a value from an enum, so the type is recreated. Only one
-- column is typed CompanyStatus; its default has to come off first because the
-- default expression is bound to the old type.

-- The one live row is a company whose board is already open — the state the
-- status was reaching for and failing to reach, since runShortlist only set
-- SHORTLISTING on a fresh seed and this board was a re-show. Any SCANNING row
-- without a board never got past the metadata pass, so READY is the truth.
UPDATE "CompanyInteraction" ci
SET status = CASE
  WHEN EXISTS (
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
  ) THEN 'SHORTLISTING'::"CompanyStatus"
  ELSE 'READY'::"CompanyStatus"
END
WHERE ci.status = 'SCANNING';

ALTER TABLE "CompanyInteraction" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "CompanyStatus" RENAME TO "CompanyStatus_old";

CREATE TYPE "CompanyStatus" AS ENUM (
  'NEW',
  'READY',
  'SHORTLISTING',
  'APPLYING',
  'IN_FLIGHT',
  'IN_PROCESS',
  'CAUGHT_UP',
  'PAUSED',
  'BLOCKED',
  'CLOSED'
);

ALTER TABLE "CompanyInteraction"
  ALTER COLUMN "status" TYPE "CompanyStatus"
  USING "status"::text::"CompanyStatus";

ALTER TABLE "CompanyInteraction"
  ALTER COLUMN "status" SET DEFAULT 'NEW'::"CompanyStatus";

DROP TYPE "CompanyStatus_old";

-- Survivors of the metadata pass, so a scan that dies partway doesn't send the
-- next entry back through it. Null on every existing row is correct: they get
-- one more pass, which is exactly today's behaviour.
ALTER TABLE "JobInteraction" ADD COLUMN "preScannedAt" TIMESTAMP(3);
