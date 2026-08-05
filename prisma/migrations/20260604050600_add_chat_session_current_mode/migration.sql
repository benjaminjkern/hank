-- Add ChatSession.currentMode — anchors the agent to a named mode
-- (profile_enhancement / discovery / walkthrough). Nullable: most sessions
-- are in the default between-modes state most of the time.
ALTER TABLE "ChatSession" ADD COLUMN "currentMode" TEXT;
