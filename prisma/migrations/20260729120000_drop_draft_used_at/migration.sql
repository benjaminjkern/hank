-- Drop the draft "usage" tracking columns.
--
-- These recorded whether the USER (not the agent) had edited or copied a draft
-- artifact. Every consumer has been re-based on the reuse flags, which the same
-- edit/copy actions already set: the two signals never diverged in prod (0 rows
-- with coverLetterReuse = true and coverLetterUsedAt null), so "did they use it"
-- was a second encoding of "may we reuse it".
--
-- Wipe-on-APPLIED, the one consumer that needed the distinction, is removed
-- rather than re-based: keying deletion off the reuse switch would silently
-- destroy a letter the user wrote and then marked not-reusable.
ALTER TABLE "JobInteraction" DROP COLUMN "coverLetterUsedAt";
ALTER TABLE "JobInteraction" DROP COLUMN "shortAnswersUsedAt";
