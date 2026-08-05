-- Add a BLOCKED company status: a *technical* set-aside (couldn't read the
-- board), distinct from CLOSED (a judgment the company won't work out).
-- The new enum value must NOT be used in the same transaction it's added
-- (Postgres restriction) — the CLOSED+CANNOT_SCRAPE → BLOCKED backfill that
-- USES this value lives in the next migration (…_backfill_cannot_scrape_to_blocked).

-- 1. New status value (additive; safe to add here, used only in the next migration).
ALTER TYPE "CompanyStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';

-- 2. Reason enum for why a company is BLOCKED (a freshly-created type — safe to
--    reference for the new columns below in this same transaction).
CREATE TYPE "CompanyBlockReason" AS ENUM (
  'CANNOT_SCRAPE',
  'AMBIGUOUS_NAME',
  'NO_OWN_BOARD',
  'AUTH_WALLED',
  'OTHER'
);

-- 3. Block fields on CompanyInteraction — populated when status=BLOCKED, cleared
--    on transition out (mirrors the closeReason/closeNote + deferReason pattern).
ALTER TABLE "CompanyInteraction"
  ADD COLUMN "blockReason" "CompanyBlockReason",
  ADD COLUMN "blockNote" TEXT;
