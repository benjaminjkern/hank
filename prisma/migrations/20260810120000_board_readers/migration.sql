-- Learned board readers: how we read a job board no wired provider recognizes.
--
-- No backfill. Every existing Company's boardReaderId is correctly NULL — it
-- means "a wired provider handles this, or nothing has looked yet", which is
-- exactly the state they're all in.

CREATE TYPE "BoardReaderOrigin" AS ENUM ('PROBE', 'RECON');
CREATE TYPE "BoardReaderHealth" AS ENUM ('HEALTHY', 'QUARANTINED');

CREATE TABLE "BoardReader" (
    "id" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "familyKey" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "recipe" JSONB,
    "origin" "BoardReaderOrigin" NOT NULL,
    "health" "BoardReaderHealth" NOT NULL DEFAULT 'HEALTHY',
    "lastRunAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "jobsLastRun" INTEGER,
    "missingLastRun" INTEGER,
    "overlapLastRun" DOUBLE PRECISION,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "needsBrowser" BOOLEAN NOT NULL DEFAULT false,
    "reconNote" TEXT,
    "reconnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardReader_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BoardReader_matchKey_key" ON "BoardReader"("matchKey");
CREATE INDEX "BoardReader_familyKey_idx" ON "BoardReader"("familyKey");
CREATE INDEX "BoardReader_health_idx" ON "BoardReader"("health");

ALTER TABLE "Company" ADD COLUMN "boardReaderId" TEXT;

CREATE INDEX "Company_boardReaderId_idx" ON "Company"("boardReaderId");

ALTER TABLE "Company" ADD CONSTRAINT "Company_boardReaderId_fkey"
    FOREIGN KEY ("boardReaderId") REFERENCES "BoardReader"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
