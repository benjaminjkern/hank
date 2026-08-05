-- Make coverLetterReuse nullable so it can carry tri-state, matching how
-- shortAnswersReuse (Json? with null entries) already behaves:
--   NULL  -> derive from used-state (used cover ⇒ reuse on; unused draft ⇒ off)
--   true  -> explicitly feed future drafting, even if never used
--   false -> explicitly exclude
--
-- Backfill: every existing row currently holds `true` — that was the old
-- NOT-NULL default meaning "reuse if used". Collapse those default-true rows to
-- NULL so they keep behaving exactly as before (derive-from-used), while
-- preserving any explicit `false` opt-outs a user already set. Under the old
-- code no user could set reuse=true on an *unused* draft (the switch only
-- rendered for used artifacts), so resetting true→NULL loses no intent.
ALTER TABLE "JobInteraction" ALTER COLUMN "coverLetterReuse" DROP DEFAULT;
ALTER TABLE "JobInteraction" ALTER COLUMN "coverLetterReuse" DROP NOT NULL;
UPDATE "JobInteraction" SET "coverLetterReuse" = NULL WHERE "coverLetterReuse" = true;
