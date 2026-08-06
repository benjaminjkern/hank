-- What the company search proposed and what the user did with it, so a decline
-- is durable and feedable instead of a lost click.

CREATE TYPE "CompanySuggestionVerdict" AS ENUM ('ADDED', 'DECLINED');

CREATE TYPE "CompanySuggestionDeclineReason" AS ENUM (
  'TOO_LARGE',
  'TOO_EARLY',
  'WRONG_DOMAIN',
  'ALREADY_KNOWN',
  'NOT_INTERESTED',
  'OTHER'
);

CREATE TABLE "CompanySuggestion" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "nameKey"   TEXT NOT NULL,
  "reason"    TEXT NOT NULL,
  "url"       TEXT,
  "verdict"   "CompanySuggestionVerdict",
  "declineReason" "CompanySuggestionDeclineReason",
  "declineNote"   TEXT,
  "runId"     TEXT,
  "sessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),

  CONSTRAINT "CompanySuggestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CompanySuggestion_userId_nameKey_idx"
  ON "CompanySuggestion"("userId", "nameKey");
CREATE INDEX "CompanySuggestion_userId_createdAt_idx"
  ON "CompanySuggestion"("userId", "createdAt");

ALTER TABLE "CompanySuggestion"
  ADD CONSTRAINT "CompanySuggestion_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
