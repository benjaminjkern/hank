import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";

import { AdminDeletionsView, type DeletionRow } from "./AdminDeletionsView";

export const dynamic = "force-dynamic";

// Company and Job are GLOBAL tables (no userId column) — the admin gate is
// the only access control on this page. The agent's recommend_*_for_deletion
// tools write to the global rows directly.
export default async function AdminDeletionsPage() {
  await requireAdmin();

  const [companies, jobs] = await Promise.all([
    prisma.company.findMany({
      where: { deletionRecommendedAt: { not: null } },
      orderBy: { deletionRecommendedAt: "desc" },
      select: {
        id: true,
        name: true,
        sourceUrl: true,
        deletionRecommendedAt: true,
        deletionRecommendedReason: true,
      },
    }),
    prisma.job.findMany({
      where: { deletionRecommendedAt: { not: null } },
      orderBy: { deletionRecommendedAt: "desc" },
      select: {
        id: true,
        title: true,
        sourceUrl: true,
        companyName: true,
        company: { select: { name: true } },
        deletionRecommendedAt: true,
        deletionRecommendedReason: true,
      },
    }),
  ]);

  const companyRows: DeletionRow[] = companies.map((c) => ({
    id: c.id,
    kind: "company",
    title: c.name,
    sourceUrl: c.sourceUrl,
    parentLabel: null,
    reason: c.deletionRecommendedReason ?? "(no reason provided)",
    recommendedAt: c.deletionRecommendedAt!.toISOString(),
  }));
  const jobRows: DeletionRow[] = jobs.map((j) => ({
    id: j.id,
    kind: "job",
    title: j.title,
    sourceUrl: j.sourceUrl,
    parentLabel: j.company?.name ?? j.companyName ?? null,
    reason: j.deletionRecommendedReason ?? "(no reason provided)",
    recommendedAt: j.deletionRecommendedAt!.toISOString(),
  }));

  return <AdminDeletionsView companies={companyRows} jobs={jobRows} />;
}
