-- Make the physical names match the Prisma names: drop all four @map/@@map
-- aliases. Pure renames — no data is read, written, or reshaped.
--
-- Postgres does NOT cascade a table rename to its indexes and constraints, so
-- each derived object is renamed explicitly. Skipping them leaves `prisma
-- migrate diff` reporting permanent drift.
--
-- DEPLOY ORDERING: code compiled before this migration queries "Event" /
-- "EventType" / "location" / "finalToolName" and breaks the moment it lands.
-- Apply and redeploy back-to-back.

-- JobEvent: table, its primary key, its index, and its FK to JobInteraction.
ALTER TABLE "Event" RENAME TO "JobEvent";
ALTER INDEX "Event_pkey" RENAME TO "JobEvent_pkey";
ALTER INDEX "Event_jobInteractionId_idx" RENAME TO "JobEvent_jobInteractionId_idx";
ALTER TABLE "JobEvent" RENAME CONSTRAINT "Event_jobInteractionId_fkey" TO "JobEvent_jobInteractionId_fkey";

-- The event vocabulary. Only "Event"."type" uses this type.
ALTER TYPE "EventType" RENAME TO "JobEventType";

-- Job.location has always meant place + work arrangement, which is what the
-- Prisma-side name says. No index or constraint references it.
ALTER TABLE "Job" RENAME COLUMN "location" TO "locationAndArrangement";

-- SubAgentRun.finalToolName records which output SCHEMA a sub-agent emitted;
-- an output schema is not a tool. No index or constraint references it.
ALTER TABLE "SubAgentRun" RENAME COLUMN "finalToolName" TO "outputSchemaName";
