-- Job closure (Phase 3). Both additive — the closedAt column doesn't reference
-- the new enum value, so there's no same-transaction ADD-VALUE-then-use hazard
-- and they can share one migration.

-- AlterTable: global "this posting was taken down" timestamp (detected on
-- re-fetch when the board no longer returns the job).
ALTER TABLE "Job" ADD COLUMN "closedAt" TIMESTAMP(3);

-- AlterEnum: per-user projection of a closed posting. Not used by any statement
-- in this migration, so the ADD VALUE is safe here.
ALTER TYPE "InteractionStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
