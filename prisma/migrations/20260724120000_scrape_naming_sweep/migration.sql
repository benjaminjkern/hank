-- Scrape naming sweep: unify the board-pull vocabulary on "scrape".
--
-- 1. CompanyInteraction.lastScannedAt -> lastScrapedJobsAt. The Prisma field was
--    already lastFetchedJobsAt @map("lastScannedAt"); this drops the @map so the
--    physical column, Prisma field, and UI copy ("Scraped Nd ago") all agree.
ALTER TABLE "CompanyInteraction" RENAME COLUMN "lastScannedAt" TO "lastScrapedJobsAt";

-- 2. CompanyEventType.SCAN_FOUND -> SCRAPE_FOUND. Internal only (the UI label is
--    "New roles"); renamed so no board-pull concept wears a "scan" name.
ALTER TYPE "CompanyEventType" RENAME VALUE 'SCAN_FOUND' TO 'SCRAPE_FOUND';
