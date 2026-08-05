-- Schema changes for the add_to_watchlist orchestrator + URL/ATS hunter
-- sub-agent. See docs/sub-agents.md for the pipeline shape.
--
-- 1. Company.sourceUrl becomes nullable so the orchestrator can create a
--    Company stub before the hunter has found a working URL. Postgres
--    unique constraints natively allow multiple NULL values, so the
--    existing @unique stays. Stub survives CANNOT_SCRAPE so the user can
--    later provide a URL by hand.
-- 2. Company.description holds the hunter's short factual one-liner.
--    Longer narrative notes still live in companies/{slug}.md memory.
-- 3. Company.huntingStartedAt is the transient "Scanning…" badge signal.
--    Set on stub creation, cleared on pipeline completion. Stale values
--    (>2min) mean the orchestrator crashed mid-run.

ALTER TABLE "Company" ALTER COLUMN "sourceUrl" DROP NOT NULL;
ALTER TABLE "Company" ADD COLUMN "description" TEXT;
ALTER TABLE "Company" ADD COLUMN "huntingStartedAt" TIMESTAMP(3);
