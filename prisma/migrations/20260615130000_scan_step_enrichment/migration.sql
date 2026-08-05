-- Scan-step overhaul (2026-06-15): per-job enrich + match.
--
-- Job-global enrichment (computed once, reused across users):
ALTER TABLE "Job" ADD COLUMN "enrichedSummary" TEXT;
ALTER TABLE "Job" ADD COLUMN "enrichedAttributes" JSONB;

-- Per-user match verdict from the scan step's match pass:
CREATE TYPE "MatchBucket" AS ENUM ('STRONG', 'POSSIBLE', 'WEAK');
ALTER TABLE "JobInteraction" ADD COLUMN "matchBucket" "MatchBucket";
ALTER TABLE "JobInteraction" ADD COLUMN "matchScore" INTEGER;
ALTER TABLE "JobInteraction" ADD COLUMN "matchReason" TEXT;

-- NOTE: SkipReason.OUTRANKED is intentionally NOT dropped — Postgres can't
-- remove an enum value referenced by historical rows. It is retired in code
-- (the prescan rollup that wrote it is gone) and existing rows are backfilled
-- to OTHER via a separate, gated data migration (see the overhaul notes).
