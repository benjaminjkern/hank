-- Manually-created jobs (from chat, no scraped posting) don't always have a
-- sourceUrl or full rawContent. Drop the NOT NULL constraint on both. The
-- @unique index on sourceUrl is preserved; Postgres unique indexes treat
-- multiple NULLs as distinct, so manual jobs without URLs don't collide.
ALTER TABLE "Job" ALTER COLUMN "sourceUrl" DROP NOT NULL;
ALTER TABLE "Job" ALTER COLUMN "rawContent" DROP NOT NULL;
