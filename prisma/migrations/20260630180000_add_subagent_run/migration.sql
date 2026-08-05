-- CreateTable: SubAgentRun — one row per real sub-agent invocation (input + final output).
-- Read by the sub-agent runtime audit (scripts/subagent-runtime-audit/).
CREATE TABLE "SubAgentRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "operation" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "finalToolName" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "turns" INTEGER,
    "seeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubAgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubAgentRun_operation_createdAt_idx" ON "SubAgentRun"("operation", "createdAt");

-- CreateIndex
CREATE INDEX "SubAgentRun_createdAt_idx" ON "SubAgentRun"("createdAt");

-- CreateIndex
CREATE INDEX "SubAgentRun_userId_createdAt_idx" ON "SubAgentRun"("userId", "createdAt");
