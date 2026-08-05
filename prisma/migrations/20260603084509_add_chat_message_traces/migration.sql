-- Per-tool sub-agent traces keyed by parent assistant tool_use id.
ALTER TABLE "ChatMessage" ADD COLUMN "traces" JSONB;
