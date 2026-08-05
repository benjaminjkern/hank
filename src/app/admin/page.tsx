import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";
import { costOf } from "@/server/platform/usage/pricing";
import { money } from "@/utils/format";

import { AdminIndexView } from "./AdminIndexView";

export const dynamic = "force-dynamic";

export default async function AdminIndexPage() {
  await requireAdmin();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayAgo = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);

  const [openNotes, companyRecs, jobRecs, todayRows, userCount, recentRuns] =
    await Promise.all([
      prisma.adminNote.count({ where: { dismissed: false } }),
      prisma.company.count({ where: { deletionRecommendedAt: { not: null } } }),
      prisma.job.count({ where: { deletionRecommendedAt: { not: null } } }),
      prisma.tokenUsage.findMany({
        where: { createdAt: { gte: startOfToday } },
        select: {
          model: true,
          inputTokens: true,
          outputTokens: true,
          cacheCreationInputTokens: true,
          cacheReadInputTokens: true,
          webSearchRequests: true,
        },
      }),
      prisma.user.count(),
      // Distinct runIds seen in the last 24h — the run-tree inspector's headline.
      prisma.chatMessage.findMany({
        where: { runId: { not: null }, createdAt: { gte: dayAgo } },
        select: { runId: true },
        distinct: ["runId"],
      }),
    ]);

  const todayCost = todayRows.reduce((acc, r) => acc + costOf(r), 0);

  return (
    <AdminIndexView
      openNotes={openNotes}
      deletionRecs={companyRecs + jobRecs}
      todayCostLabel={money(todayCost)}
      userCount={userCount}
      runsLast24h={recentRuns.length}
    />
  );
}
