-- Part 1 of 2 — adds the new enum values that part 2 uses in INSERT/UPDATE.
-- Postgres won't let you ADD VALUE and then use that value in the same
-- transaction; splitting the migration guarantees the values are committed
-- before the backfill in part 2 references them.

ALTER TYPE "InteractionStatus" ADD VALUE IF NOT EXISTS 'PITCHED';
ALTER TYPE "OpportunityStatus" ADD VALUE IF NOT EXISTS 'OPEN';
