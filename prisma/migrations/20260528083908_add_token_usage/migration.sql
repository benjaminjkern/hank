-- CreateTable
CREATE TABLE "TokenUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operation" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "webSearchRequests" INTEGER NOT NULL DEFAULT 0,
    "sessionId" TEXT,
    "notes" TEXT,

    CONSTRAINT "TokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenUsage_userId_createdAt_idx" ON "TokenUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenUsage_operation_createdAt_idx" ON "TokenUsage"("operation", "createdAt");
