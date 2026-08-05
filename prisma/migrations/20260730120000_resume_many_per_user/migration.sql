-- Resume becomes many-per-user, and stops carrying the parse.
--
-- What the resume SAYS now lives in exactly one place: the `resume.md` memory
-- note, which every upload merges into. The row is the FILE. So `parsedText` and
-- `parsedSummary` go, and the PK moves off `userId` so a user can upload more
-- than one document and have all of them fold into the same background note.

-- 1. New surrogate PK. Existing rows get a cuid-shaped id; there is no gen_cuid()
--    in Postgres, so mint a collision-free stand-in from the row's own userId —
--    these are opaque handles, never shown to the agent.
ALTER TABLE "Resume" ADD COLUMN "id" TEXT;
UPDATE "Resume" SET "id" = 'res_' || "userId" WHERE "id" IS NULL;
ALTER TABLE "Resume" ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE "Resume" DROP CONSTRAINT "Resume_pkey";
ALTER TABLE "Resume" ADD CONSTRAINT "Resume_pkey" PRIMARY KEY ("id");

CREATE INDEX "Resume_userId_uploadedAt_idx" ON "Resume"("userId", "uploadedAt");

-- 2. The parse is no longer stored on the row.
ALTER TABLE "Resume" DROP COLUMN "parsedText";
ALTER TABLE "Resume" DROP COLUMN "parsedSummary";
