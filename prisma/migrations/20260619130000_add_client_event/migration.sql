-- Browser-side error/diagnostic events (HANK-349). Reported via
-- POST /api/client-events. Feeds the per-turn <recent-client-errors> block and
-- the AdminNote fan-out (problem subset, dedup by occurrence). FK actions mirror
-- AdminNote: required userId/sessionId RESTRICT, optional messageId SET NULL.

CREATE TABLE "ClientEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warn',
    "summary" TEXT NOT NULL,
    "context" JSONB,
    "dedupKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientEvent_sessionId_createdAt_idx" ON "ClientEvent"("sessionId", "createdAt");
CREATE INDEX "ClientEvent_userId_dedupKey_createdAt_idx" ON "ClientEvent"("userId", "dedupKey", "createdAt");

ALTER TABLE "ClientEvent" ADD CONSTRAINT "ClientEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClientEvent" ADD CONSTRAINT "ClientEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClientEvent" ADD CONSTRAINT "ClientEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
