-- Add scraped application form questions to Job. Envelope shape lives in
-- src/server/scrape/types.ts (ApplicationQuestionsEnvelope). Greenhouse jobs
-- are populated lazily on first get_job_details; other ATSes stay
-- {status:"unsupported"} until we add scraping for them.
ALTER TABLE "Job" ADD COLUMN "applicationQuestions" JSONB;
