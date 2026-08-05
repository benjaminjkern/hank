-- JobInteraction.notes was a second, weaker home for per-pursuit context that
-- MemoryNote (`jobs/{slug}.md`) already covers better — it's slug-addressed,
-- readable/writable by the agent through read_memory/write_memory, folded by
-- the compaction consolidation pass, and it survives the row. Nothing wrote it
-- but update_job_interaction, and only two views read it. Dropping the column
-- removes the duplicate storage shape; the structured per-status "why" columns
-- (closeReason/closeNote, deferReason/deferNote) stay.

ALTER TABLE "JobInteraction" DROP COLUMN "notes";
