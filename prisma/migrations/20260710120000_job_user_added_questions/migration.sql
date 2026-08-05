-- User-contributed application questions, added by hand when the ATS form
-- couldn't be scraped. GLOBAL on the Job (shared across users) but each entry
-- carries provenance ({question, type?, required?, addedByUserId, addedAt}) so
-- it's auditable and flagged unverified. Additive, nullable; kept separate from
-- applicationQuestions so a re-scrape never wipes it.
ALTER TABLE "Job" ADD COLUMN "userAddedQuestions" JSONB;
