-- Add pausedWalkthroughCompanyId to ChatSession. The walkthrough runner stamps
-- this with the company arm being abandoned when it detects a side-trip
-- (focus leaving the company), then flips currentFlow to "default". The
-- default flow's state machine reads this to emit a "Resume <Company>
-- walkthrough?" widget after the side-trip wraps.
ALTER TABLE "ChatSession" ADD COLUMN "pausedWalkthroughCompanyId" TEXT;
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_pausedWalkthroughCompanyId_fkey"
  FOREIGN KEY ("pausedWalkthroughCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- No DB rename of currentMode → currentFlow. The Prisma schema uses
-- @map("currentMode") to expose the column as currentFlow on the type side
-- without touching the live column. A cleanup migration can rename the
-- physical column later if desired.
