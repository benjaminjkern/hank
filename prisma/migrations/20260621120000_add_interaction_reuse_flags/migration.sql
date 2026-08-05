-- "Keep in my profile" reuse toggles for application artifacts.
-- coverLetterReuse=false → exclude the used cover letter from loadPastDrafts.
-- shortAnswersReuse is a parallel boolean[] to shortAnswers (null index ⇒ reuse).
-- Both are orthogonal to the *UsedAt stamps and wipe-on-APPLIED. Additive,
-- defaulting to reuse so existing used answers keep feeding drafting.
ALTER TABLE "JobInteraction" ADD COLUMN "coverLetterReuse" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "JobInteraction" ADD COLUMN "shortAnswersReuse" JSONB;
