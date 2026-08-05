-- Add DEFERRED to both interaction status enums. ALTER TYPE ... ADD VALUE
-- is non-destructive and preserves all existing rows.
ALTER TYPE "CompanyStatus" ADD VALUE IF NOT EXISTS 'DEFERRED';
ALTER TYPE "InteractionStatus" ADD VALUE IF NOT EXISTS 'DEFERRED';

-- New reason enums. Distinct from the SKIP reason enums because the
-- semantics differ: SKIPPED is structurally closed; DEFERRED is "come back
-- later, conditions could flip".
CREATE TYPE "CompanyDeferReason" AS ENUM (
  'STRUCTURAL_FLIP_POSSIBLE',
  'NO_ROLES_VIABLE_NOW',
  'USER_PAUSED',
  'AWAITING_SIGNAL',
  'OTHER'
);

CREATE TYPE "JobDeferReason" AS ENUM (
  'WAITING_FOR_REFERRAL',
  'TIMING_EXTERNAL',
  'TIMING_USER',
  'IN_OTHER_ROUNDS',
  'NEEDS_PREP',
  'OTHER'
);

-- Per-row defer fields. All nullable: populated on DEFERRED, cleared on
-- transition out. `deferredUntil` is optional even when status=DEFERRED
-- (some defers are open-ended; whats_next rung 2 surfaces dated ones once
-- the date passes).
ALTER TABLE "CompanyInteraction"
  ADD COLUMN "deferReason" "CompanyDeferReason",
  ADD COLUMN "deferNote" TEXT,
  ADD COLUMN "deferredUntil" TIMESTAMP(3);

ALTER TABLE "JobInteraction"
  ADD COLUMN "deferReason" "JobDeferReason",
  ADD COLUMN "deferNote" TEXT,
  ADD COLUMN "deferredUntil" TIMESTAMP(3);
