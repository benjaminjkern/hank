-- Add an admin gate to User and a new AdminNote table the agent writes to via
-- the hidden `record_observation` tool. AdminNote rows surface in /admin/notes
-- for triage; existing rows default to dismissed=false so new ones land in the
-- open queue. isAdmin defaults to false; flip the LOCAL_USER_ID row to true
-- after this migration (or rerun `pnpm db:seed`).

ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AdminNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "category" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "context" TEXT,
    "dismissed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminNote_userId_dismissed_createdAt_idx" ON "AdminNote"("userId", "dismissed", "createdAt");

ALTER TABLE "AdminNote" ADD CONSTRAINT "AdminNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminNote" ADD CONSTRAINT "AdminNote_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminNote" ADD CONSTRAINT "AdminNote_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
