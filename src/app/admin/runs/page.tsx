import type { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";
import { costOf } from "@/server/platform/usage/pricing";

import { RunsIndexView } from "./RunsIndexView";

import type { RunSummary, RunsIndexData } from "./types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type SearchParams = Promise<{
  user?: string;
  session?: string;
  run?: string;
  page?: string;
}>;

// pipeline=X in a TokenUsage note → the flow that produced the run.
function flowFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  const m = notes.match(/pipeline=(\w+)/);
  return m ? m[1] : null;
}

export default async function AdminRunsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdmin();

  const params = await searchParams;
  const filterUser = params.user?.trim() || null;
  const filterSession = params.session?.trim() || null;
  const filterRun = params.run?.trim() || null;
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  // Build the run set (ChatMessage grouping) for the active filter. `?user=`
  // resolves through the user's sessions since ChatMessage has no userId.
  let where: Prisma.ChatMessageWhereInput;
  if (filterRun) {
    where = { runId: filterRun };
  } else if (filterSession) {
    where = { runId: { not: null }, sessionId: filterSession };
  } else if (filterUser) {
    const userSessions = await prisma.chatSession.findMany({
      where: { userId: filterUser },
      select: { id: true },
    });
    where = {
      runId: { not: null },
      sessionId: { in: userSessions.map((s) => s.id) },
    };
  } else {
    where = { runId: { not: null } };
  }

  // One page of runs, newest activity first. runId→sessionId is 1:1, so grouping
  // by both yields one row per run and carries the sessionId along. take+1 detects
  // a next page without a full count.
  const grouped = await prisma.chatMessage.groupBy({
    by: ["runId", "sessionId"],
    where,
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
  });
  const hasNext = grouped.length > PAGE_SIZE;
  const pageRuns = grouped.slice(0, PAGE_SIZE);
  const runIds = pageRuns
    .map((g) => g.runId)
    .filter((id): id is string => !!id);

  // Per-run metadata for just this page: cost + flow + turn count (TokenUsage),
  // and which runs were interrupted (ChatMessage.stoppedByUser).
  const [usageRows, stoppedRows] = await Promise.all([
    runIds.length
      ? prisma.tokenUsage.findMany({
          where: { runId: { in: runIds } },
          select: {
            runId: true,
            notes: true,
            model: true,
            inputTokens: true,
            outputTokens: true,
            cacheCreationInputTokens: true,
            cacheReadInputTokens: true,
            webSearchRequests: true,
            operation: true,
          },
        })
      : [],
    runIds.length
      ? prisma.chatMessage.findMany({
          where: { runId: { in: runIds }, stoppedByUser: true },
          select: { runId: true },
          distinct: ["runId"],
        })
      : [],
  ]);
  const costByRun = new Map<string, number>();
  const flowByRun = new Map<string, string | null>();
  const turnsByRun = new Map<string, number>();
  for (const u of usageRows) {
    if (!u.runId) continue;
    costByRun.set(u.runId, (costByRun.get(u.runId) ?? 0) + costOf(u));
    if (!flowByRun.get(u.runId)) flowByRun.set(u.runId, flowFromNotes(u.notes));
    if (u.operation === "chat") {
      turnsByRun.set(u.runId, (turnsByRun.get(u.runId) ?? 0) + 1);
    }
  }
  const stoppedRuns = new Set(
    stoppedRows.map((r) => r.runId).filter((id): id is string => !!id),
  );

  // Owning user per session → email.
  const sessionIds = [...new Set(pageRuns.map((g) => g.sessionId))];
  const sessions = await prisma.chatSession.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, userId: true },
  });
  const userIdBySession = new Map(sessions.map((s) => [s.id, s.userId]));
  const userIds = [...new Set(sessions.map((s) => s.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, name: true },
  });
  const emailByUser = new Map<string, string | null>(
    users.map((u) => [u.id, u.email ?? u.name ?? null]),
  );

  const runs: RunSummary[] = pageRuns.map((g) => {
    const runId = g.runId!;
    const userId = userIdBySession.get(g.sessionId) ?? null;
    return {
      runId,
      legacy: false,
      sessionId: g.sessionId,
      userId,
      userEmail: userId ? (emailByUser.get(userId) ?? null) : null,
      createdAt: (g._max.createdAt ?? new Date(0)).toISOString(),
      turnCount: turnsByRun.get(runId) ?? 0,
      cost: costByRun.get(runId) ?? 0,
      stopped: stoppedRuns.has(runId),
      flow: flowByRun.get(runId) ?? null,
    };
  });

  const data: RunsIndexData = {
    runs,
    filter: { user: filterUser, session: filterSession, run: filterRun },
    page,
    pageSize: PAGE_SIZE,
    hasNext,
  };

  return <RunsIndexView data={data} />;
}
