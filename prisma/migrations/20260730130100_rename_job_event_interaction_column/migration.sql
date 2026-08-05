-- Rename the physical column "Event"."interactionId" -> "jobInteractionId" so
-- the DB name matches the Prisma field, and drop the @map that stood in for it.
-- The name was ambiguous for the same reason the enum was: there are two
-- interaction tables, and this FK only ever points at JobInteraction.
--
-- The index and FK constraint carry the old column name too; Prisma derives
-- both from the column, so all three rename together or the schema reports
-- drift.
--
-- METADATA-ONLY: RENAME COLUMN / RENAME CONSTRAINT / ALTER INDEX ... RENAME all
-- rewrite catalog entries, not rows.
--
-- Raw SQL must use the physical names: src/server/entities/jobs/
-- flipDueInterviews.ts selects e."jobInteractionId" FROM "Event" (the table
-- itself is still @@map'd to "Event").

ALTER TABLE "Event" RENAME COLUMN "interactionId" TO "jobInteractionId";
ALTER TABLE "Event" RENAME CONSTRAINT "Event_interactionId_fkey" TO "Event_jobInteractionId_fkey";
ALTER INDEX "Event_interactionId_idx" RENAME TO "Event_jobInteractionId_idx";
