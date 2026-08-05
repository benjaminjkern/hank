-- Adds a nullable toolName column to TokenUsage so per-tool cost attribution
-- (e.g. search_jobs vs get_job_details) can be reported directly out of
-- TokenUsage instead of reconstructed by timestamp-joining against ChatMessage.

ALTER TABLE "TokenUsage" ADD COLUMN "toolName" TEXT;
