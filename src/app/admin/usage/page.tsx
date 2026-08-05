import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";
import { costOf, priceFor } from "@/server/platform/usage/pricing";
import { nowMs } from "@/utils/now";

import { AdminUsageView, type UsageSummary } from "./AdminUsageView";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_IN_CHART = 30;

// All day-bucketing is in Pacific time (the maintainer's local), not the server's UTC.
// `ptDay` returns the YYYY-MM-DD a given instant falls on in Los Angeles —
// en-CA formats as ISO-style dates, and the tz handles PST/PDT automatically.
const PT_TZ = "America/Los_Angeles";
const ptDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: PT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function ptDay(d: Date): string {
  return ptDateFmt.format(d);
}

type SearchParams = Promise<{ user?: string; session?: string }>;

type Row = {
  createdAt: Date;
  userId: string;
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  webSearchRequests: number;
  sessionId: string | null;
  notes: string | null;
  billedToServer: boolean;
};

type AggCommon = {
  calls: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  webSearch: number;
  cost: number;
  // Bill-source split of `cost`: serverCost = paid on our key, userCost = paid
  // on the user's own key (= what we'd have been charged at our rates).
  serverCost: number;
  userCost: number;
};

function emptyAgg(): AggCommon {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    webSearch: 0,
    cost: 0,
    serverCost: 0,
    userCost: 0,
  };
}

function addRow(a: AggCommon, r: Row, c: number) {
  a.calls += 1;
  a.input += r.inputTokens;
  a.output += r.outputTokens;
  a.cacheCreate += r.cacheCreationInputTokens;
  a.cacheRead += r.cacheReadInputTokens;
  a.webSearch += r.webSearchRequests;
  a.cost += c;
  if (r.billedToServer) a.serverCost += c;
  else a.userCost += c;
}

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdmin();

  const params = await searchParams;
  const filterUser = params.user?.trim() || null;
  const filterSession = params.session?.trim() || null;

  // Single fetch — TokenUsage is small (≤ a few thousand rows for v0). Move to
  // SQL aggregation if it grows past memory comfort.
  const allRows = (await prisma.tokenUsage.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      createdAt: true,
      userId: true,
      operation: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheCreationInputTokens: true,
      cacheReadInputTokens: true,
      webSearchRequests: true,
      sessionId: true,
      notes: true,
      billedToServer: true,
    },
  })) as Row[];

  // Resolve userId → email/name for display (both the byUser table and the
  // "who owns this session" labels). One lookup over the distinct ids present.
  const userIds = [...new Set(allRows.map((r) => r.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, name: true },
  });
  const userLabel = new Map<string, string | null>(
    users.map((u) => [u.id, u.email ?? u.name ?? null]),
  );
  // Each session's owning user (sessions are single-user; first row wins).
  const sessionUser = new Map<string, string>();
  for (const r of allRows) {
    if (r.sessionId && !sessionUser.has(r.sessionId)) {
      sessionUser.set(r.sessionId, r.userId);
    }
  }

  // Apply the active filter (if any) before aggregating, so every section
  // reflects the scoped slice.
  const rows = allRows.filter((r) => {
    if (filterUser && r.userId !== filterUser) return false;
    if (filterSession && r.sessionId !== filterSession) return false;
    return true;
  });

  const now = nowMs();
  const todayKey = ptDay(new Date(now));
  const sevenAgo = now - 7 * DAY_MS;
  const thirtyAgo = now - 30 * DAY_MS;

  let totalAll = 0;
  let total30 = 0;
  let total7 = 0;
  let totalToday = 0;
  let billedToUs = 0;
  let billedToUsers = 0;
  let cacheSavings = 0;
  let cacheReadTotal = 0;
  let cacheableInputTotal = 0; // input + cache_read — the denominator for hit rate

  const byOp = new Map<string, AggCommon>();
  const byModel = new Map<string, AggCommon>();
  const bySession = new Map<string, AggCommon>();
  const byUser = new Map<string, AggCommon>();

  // Daily buckets keyed by Pacific YYYY-MM-DD.
  const dailyMap = new Map<string, number>();

  for (const r of rows) {
    const c = costOf(r);
    const t = r.createdAt.getTime();
    totalAll += c;
    if (t >= thirtyAgo) total30 += c;
    if (t >= sevenAgo) total7 += c;
    if (ptDay(r.createdAt) === todayKey) totalToday += c;
    if (r.billedToServer) billedToUs += c;
    else billedToUsers += c;

    const p = priceFor(r.model);
    cacheSavings +=
      (r.cacheReadInputTokens / 1_000_000) * (p.input - p.cacheRead);
    cacheReadTotal += r.cacheReadInputTokens;
    cacheableInputTotal += r.cacheReadInputTokens + r.inputTokens;

    const opAgg = byOp.get(r.operation) ?? emptyAgg();
    addRow(opAgg, r, c);
    byOp.set(r.operation, opAgg);

    const modelAgg = byModel.get(r.model) ?? emptyAgg();
    addRow(modelAgg, r, c);
    byModel.set(r.model, modelAgg);

    const userAgg = byUser.get(r.userId) ?? emptyAgg();
    addRow(userAgg, r, c);
    byUser.set(r.userId, userAgg);

    if (r.sessionId) {
      const s = bySession.get(r.sessionId) ?? emptyAgg();
      addRow(s, r, c);
      bySession.set(r.sessionId, s);
    }

    if (t >= thirtyAgo) {
      const day = ptDay(r.createdAt);
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + c);
    }
  }

  // Fill the daily series with zeros for gaps so the bar chart renders a
  // continuous 30-day (Pacific) axis.
  const daily: UsageSummary["daily"] = [];
  for (let i = DAYS_IN_CHART - 1; i >= 0; i--) {
    const key = ptDay(new Date(now - i * DAY_MS));
    daily.push({ date: key, cost: dailyMap.get(key) ?? 0 });
  }

  const byOperation = [...byOp.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([operation, a]) => ({ operation, ...a }));
  const byModelRows = [...byModel.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([model, a]) => ({ model, ...a }));
  const byUserRows = [...byUser.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([userId, a]) => ({
      userId,
      email: userLabel.get(userId) ?? null,
      ...a,
    }));
  const topSessions = [...bySession.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 15)
    .map(([sessionId, a]) => {
      const owner = sessionUser.get(sessionId) ?? null;
      return {
        sessionId,
        userId: owner,
        email: owner ? (userLabel.get(owner) ?? null) : null,
        ...a,
      };
    });

  const recent = rows
    .slice(-20)
    .reverse()
    .map((r) => ({
      createdAt: r.createdAt.toISOString(),
      operation: r.operation,
      model: r.model,
      input: r.inputTokens,
      output: r.outputTokens,
      cacheCreate: r.cacheCreationInputTokens,
      cacheRead: r.cacheReadInputTokens,
      cost: costOf(r),
      notes: r.notes,
      sessionId: r.sessionId,
      billedToServer: r.billedToServer,
    }));

  const filter: UsageSummary["filter"] = filterSession
    ? {
        kind: "session",
        sessionId: filterSession,
        userId: sessionUser.get(filterSession) ?? null,
        email: (() => {
          const owner = sessionUser.get(filterSession);
          return owner ? (userLabel.get(owner) ?? null) : null;
        })(),
      }
    : filterUser
      ? {
          kind: "user",
          userId: filterUser,
          email: userLabel.get(filterUser) ?? null,
        }
      : { kind: "none" };

  const summary: UsageSummary = {
    filter,
    totals: {
      today: totalToday,
      sevenDay: total7,
      thirtyDay: total30,
      allTime: totalAll,
    },
    billedToUs,
    billedToUsers,
    cacheReadTokens: cacheReadTotal,
    cacheableInputTokens: cacheableInputTotal,
    cacheSavings,
    byOperation,
    byModel: byModelRows,
    byUser: byUserRows,
    daily,
    topSessions,
    recent,
    rowCount: rows.length,
  };

  return <AdminUsageView summary={summary} />;
}
