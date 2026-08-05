-- Agent-flagged deletion recommendations on Job and Company. Set by
-- recommend_job_for_deletion / recommend_company_for_deletion; reviewed and
-- cleared by the admin (= user in v0) via Prisma Studio. The agent never
-- performs the actual delete; it only flags.
ALTER TABLE "Job" ADD COLUMN "deletionRecommendedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN "deletionRecommendedReason" TEXT;
ALTER TABLE "Company" ADD COLUMN "deletionRecommendedAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "deletionRecommendedReason" TEXT;
