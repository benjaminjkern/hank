-- Compaction discipline columns on ChatSession. Surfaced in the dynamic block
-- of the system prompt so the agent sees how overdue compaction is, and used
-- by the loop's 100K auto-trigger to decide when to fire compactSession
-- automatically. The "operation" column on TokenUsage is just a comment update
-- in the schema (it's a freeform String); no DDL change for that.
ALTER TABLE "ChatSession"
  ADD COLUMN "compactedAt" TIMESTAMP(3),
  ADD COLUMN "compactionDeferredCount" INTEGER NOT NULL DEFAULT 0;
