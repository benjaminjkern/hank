-- Run-tree capture: a root trace per chat run, and the exact trace node each
-- sub-agent run nested under.

CREATE TABLE "RunTrace" (
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunTrace_pkey" PRIMARY KEY ("runId")
);

ALTER TABLE "SubAgentRun" ADD COLUMN "traceParentId" TEXT;

-- Existing rows: the most specific node they ever recorded. A row under a tool
-- hangs on that tool; a run-level row hangs on the run root, whose id is the
-- runId. Rows with neither (scripts, backfill seeds) stay NULL — they belong to
-- no run.
UPDATE "SubAgentRun"
SET "traceParentId" = COALESCE("parentToolUseId", "runId")
WHERE "traceParentId" IS NULL;
