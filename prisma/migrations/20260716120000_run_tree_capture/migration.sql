-- Run-tree capture for the /admin/runs inspector.
-- All additions are nullable/additive; no backfill. Pre-instrumentation rows
-- keep NULLs and render in the viewer's degraded/heuristic mode.

-- ChatMessage: group rows into runs + order turns within a run.
ALTER TABLE "ChatMessage" ADD COLUMN "runId" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "turnIndex" INTEGER;
CREATE INDEX "ChatMessage_runId_createdAt_idx" ON "ChatMessage" ("runId", "createdAt");

-- TokenUsage: per-LLM-call spine — link to run/turn + capture params + prompt ref.
ALTER TABLE "TokenUsage" ADD COLUMN "runId" TEXT;
ALTER TABLE "TokenUsage" ADD COLUMN "messageId" TEXT;
ALTER TABLE "TokenUsage" ADD COLUMN "parentToolUseId" TEXT;
ALTER TABLE "TokenUsage" ADD COLUMN "requestParams" JSONB;
ALTER TABLE "TokenUsage" ADD COLUMN "systemPromptHash" TEXT;
CREATE INDEX "TokenUsage_runId_idx" ON "TokenUsage" ("runId");

-- SubAgentRun: nest each sub-agent under the main-agent tool_use that spawned it.
ALTER TABLE "SubAgentRun" ADD COLUMN "runId" TEXT;
ALTER TABLE "SubAgentRun" ADD COLUMN "parentMessageId" TEXT;
ALTER TABLE "SubAgentRun" ADD COLUMN "parentToolUseId" TEXT;
CREATE INDEX "SubAgentRun_runId_idx" ON "SubAgentRun" ("runId");
CREATE INDEX "SubAgentRun_parentToolUseId_idx" ON "SubAgentRun" ("parentToolUseId");

-- PromptSnapshot: deduped static system-prompt skeletons.
CREATE TABLE "PromptSnapshot" (
    "hash" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromptSnapshot_pkey" PRIMARY KEY ("hash")
);
