-- Add READY to CompanyStatus. READY is the state at the end of add_to_watchlist
-- / rescan_company when PRE_SCAN leaves survivors — i.e. "scanned, ready to
-- walk through, awaiting user engagement." Lives in the "Not started" dashboard
-- bucket alongside NEW. ACTIVE now strictly means "walkthrough in progress."
--
-- Split from the backfill (next migration) because Postgres can't reference a
-- new enum value in the same transaction that adds it.

ALTER TYPE "CompanyStatus" ADD VALUE IF NOT EXISTS 'READY';
