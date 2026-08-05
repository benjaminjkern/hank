-- Refine the "deferred" semantics + add an auto-derived company engagement tail.
--
-- Company side:
--   * ACTIVE   -> APPLYING  (clearer: "in the middle of applying")
--   * DEFERRED -> PAUSED    ("started, deliberately not working it now"; the
--                            revisit timer `deferredUntil` is retired)
--   * add IN_FLIGHT  (>=1 application submitted and still live, no reply yet)
--   * add IN_PROCESS (an employer engaged: recruiter reply / interview scheduled)
--   IN_FLIGHT / IN_PROCESS / CAUGHT_UP are auto-derived from job pipeline state
--   (deriveCompanyEngagement); no backfill needed — reads recompute going forward.
--   * CompanyDeferReason -> CompanyPauseReason; columns defer* -> pause*.
--
-- Job side:
--   * DEFERRED keeps its name, reframed as "could apply, just outranked for now".
--   * add OUTRANKED to JobDeferReason (supersedes the server-set
--     SHORTLIST_PASSED_OVER, which stays as a tombstone for in-flight rows).
--
-- All of these are METADATA-ONLY (no table rewrite, no data migration):
--   * ALTER TYPE ... RENAME VALUE preserves the enum's position, so existing
--     rows pick up the new label automatically.
--   * ALTER TYPE ... ADD VALUE appends a value (Postgres 12+ allows this inside
--     the migration transaction as long as the value isn't USED here — it isn't;
--     the code that writes IN_FLIGHT/IN_PROCESS/OUTRANKED ships separately).
--   * ALTER TYPE ... RENAME TO / ALTER TABLE ... RENAME COLUMN rename in place.
--
-- The `deferredUntil` columns on JobInteraction / CompanyInteraction are
-- intentionally NOT dropped here — kept for historical rows; no code reads them.
-- Dropping them is a separate, riskier migration for later if we want it.

-- No name collisions: neither APPLYING nor PAUSED exists on CompanyStatus yet,
-- so no free-the-name reorder is needed (unlike the SKIPPED->CLOSED rename).
ALTER TYPE "CompanyStatus" RENAME VALUE 'ACTIVE'   TO 'APPLYING';
ALTER TYPE "CompanyStatus" RENAME VALUE 'DEFERRED' TO 'PAUSED';
ALTER TYPE "CompanyStatus" ADD VALUE IF NOT EXISTS 'IN_FLIGHT';
ALTER TYPE "CompanyStatus" ADD VALUE IF NOT EXISTS 'IN_PROCESS';

-- Company defer reason enum + columns -> pause*.
ALTER TYPE "CompanyDeferReason" RENAME TO "CompanyPauseReason";
ALTER TABLE "CompanyInteraction" RENAME COLUMN "deferReason" TO "pauseReason";
ALTER TABLE "CompanyInteraction" RENAME COLUMN "deferNote"   TO "pauseNote";

-- Job defer reason: the new outranked default.
ALTER TYPE "JobDeferReason" ADD VALUE IF NOT EXISTS 'OUTRANKED';
