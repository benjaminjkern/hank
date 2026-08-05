-- First-class company-level event timeline (CompanyEvent), plus two new
-- JobEventType values (DEFERRED, DELISTED). See docs/lifecycle.md.

-- CreateEnum
CREATE TYPE "CompanyEventType" AS ENUM (
  'JOBS_CLOSED', 'SCAN_FOUND', 'SHORTLIST_RAN',
  'APPLIED', 'RESPONDED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_HAPPENED', 'OFFERED', 'REJECTED', 'WITHDRAWN',
  'PAUSED', 'BLOCKED', 'CLOSED', 'CAUGHT_UP', 'REVIVED'
);

-- CreateTable
CREATE TABLE "CompanyEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "CompanyEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "source" "EventSource" NOT NULL,
    "jobId" TEXT,
    "jobTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyEvent_userId_companyId_occurredAt_idx" ON "CompanyEvent"("userId", "companyId", "occurredAt");

-- AddForeignKey
ALTER TABLE "CompanyEvent" ADD CONSTRAINT "CompanyEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyEvent" ADD CONSTRAINT "CompanyEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum: new JobEventType values (physical type is "EventType"). Postgres
-- 12+ allows ADD VALUE inside a transaction as long as the value isn't USED in
-- the same migration (it isn't here). IF NOT EXISTS keeps it idempotent.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'DEFERRED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'DELISTED';
