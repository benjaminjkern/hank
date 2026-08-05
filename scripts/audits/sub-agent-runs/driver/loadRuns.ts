// Read SubAgentRun rows for the runtime audit. One operation at a time, oldest
// first, starting after the operation's cursor — so each Opus chunk sees a
// homogeneous batch of one sub-agent's real invocations, which keeps the
// per-operation fixtures + purpose in the (cached) system prompt coherent.

import type { PrismaClient } from "../../../../src/generated/prisma/client";

export type SubAgentRunRow = {
  id: string;
  userId: string;
  sessionId: string | null;
  operation: string;
  model: string;
  class: string;
  ok: boolean;
  outputSchemaName: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  turns: number | null;
  createdAt: Date;
};

const RUN_SELECT = {
  id: true,
  userId: true,
  sessionId: true,
  operation: true,
  model: true,
  class: true,
  ok: true,
  outputSchemaName: true,
  input: true,
  output: true,
  error: true,
  turns: true,
  createdAt: true,
} as const;

// Distinct operations that have at least one captured run — the work list. A
// registry operation with no runs is skipped; a run whose operation isn't in
// the registry (whats_next, eval_fit) still surfaces here and gets audited with
// zero static coverage.
export async function listOperationsWithRuns(
  prisma: PrismaClient,
): Promise<string[]> {
  const rows = await prisma.subAgentRun.findMany({
    distinct: ["operation"],
    select: { operation: true },
    orderBy: { operation: "asc" },
  });
  return rows.map((r) => r.operation);
}

// New runs for one operation since the cursor timestamp (exclusive). A run at
// the exact cursor boundary can re-appear across runs, but the AdminNote dedup
// collapses a re-filed finding, so a millisecond-precision `gt` is safe.
export async function loadNewRuns(
  prisma: PrismaClient,
  operation: string,
  sinceCreatedAt: Date | null,
): Promise<SubAgentRunRow[]> {
  const rows = await prisma.subAgentRun.findMany({
    where: {
      operation,
      ...(sinceCreatedAt ? { createdAt: { gt: sinceCreatedAt } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: RUN_SELECT,
  });
  return rows;
}

// Fallback session for a run that was captured without one (e.g. resume_parse
// runs before a chat session exists). AdminNote.sessionId is required, so we
// anchor to the user's most recent session; null means "file report-only".
export async function resolveFallbackSession(
  prisma: PrismaClient,
  userId: string,
): Promise<string | null> {
  const s = await prisma.chatSession.findFirst({
    where: { userId },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  return s?.id ?? null;
}
