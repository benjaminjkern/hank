-- The stored review is its findings and nothing else.
--
-- `outcome` said how ONE pass ended, on a row that outlives the pass: the relay
-- drains a settled finding out of `open` without touching it, so a row could sit
-- at "unresolved" over an empty list. Which pass ended how is now reported to
-- whoever ran it (CritiqueStop) and never stored. Nothing read the column; this
-- removes the key so a reader can't start.
UPDATE "JobInteraction"
SET "applicationReview" = "applicationReview" - 'outcome'
WHERE "applicationReview" ? 'outcome';
