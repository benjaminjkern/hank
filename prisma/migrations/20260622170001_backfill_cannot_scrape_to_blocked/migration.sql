-- Backfill: existing companies that were CLOSED only because their board
-- couldn't be read are really BLOCKED (a technical set-aside), not CLOSED (a
-- judgment). Move them to the new status, preserving the "why" as a blockReason
-- and carrying any freeform closeNote into blockNote, then clear the close fields
-- per the clear-on-transition rule. Runs in its own migration so it executes
-- after the ADD VALUE 'BLOCKED' from the previous migration has committed.
UPDATE "CompanyInteraction"
SET
  "status"      = 'BLOCKED',
  "blockReason" = 'CANNOT_SCRAPE',
  "blockNote"   = "closeNote",
  "closeReason" = NULL,
  "closeNote"   = NULL
WHERE "status" = 'CLOSED'
  AND "closeReason" = 'CANNOT_SCRAPE';
