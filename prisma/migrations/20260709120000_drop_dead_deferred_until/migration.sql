-- Drop the dead `deferredUntil` columns from JobInteraction and CompanyInteraction.
--
-- The revisit-timer feature was removed in the 2026-07-07 pause/engagement refactor
-- (a DEFERRED job / PAUSED company never auto-resurfaces — it waits for an explicit
-- revive). The columns were retained then "for historical rows," but no code has read
-- the value since, and the remaining writes only ever cleared it to NULL. Dropping is
-- safe: no logic depended on the value.

ALTER TABLE "JobInteraction" DROP COLUMN "deferredUntil";
ALTER TABLE "CompanyInteraction" DROP COLUMN "deferredUntil";
