import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";

import { BoardReadersView, type BoardReaderRow } from "./BoardReadersView";

export const dynamic = "force-dynamic";

// Which board software has earned a hand-written provider, and which boards we
// still can't read.
//
// This is the home of the "we should build a deterministic procedure for this"
// signal. It's a live table rather than a filed note because the row carries
// the actual recipe — so writing providers/{name}.ts from it is transcription,
// not re-discovery — and its company count is the priority order.
export default async function AdminBoardReadersPage() {
  await requireAdmin();
  const rows = await prisma.boardReader.findMany({
    orderBy: [{ familyKey: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      matchKey: true,
      familyKey: true,
      sourceUrl: true,
      recipe: true,
      origin: true,
      health: true,
      lastRunAt: true,
      lastSucceededAt: true,
      jobsLastRun: true,
      missingLastRun: true,
      overlapLastRun: true,
      consecutiveFailures: true,
      needsBrowser: true,
      reconNote: true,
      reconnedAt: true,
      createdAt: true,
      companies: { select: { id: true, name: true, slug: true } },
    },
  });

  const readers: BoardReaderRow[] = rows.map((r) => ({
    id: r.id,
    matchKey: r.matchKey,
    familyKey: r.familyKey,
    sourceUrl: r.sourceUrl,
    recipeJson: r.recipe == null ? null : JSON.stringify(r.recipe, null, 2),
    origin: r.origin,
    health: r.health,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastSucceededAt: r.lastSucceededAt?.toISOString() ?? null,
    jobsLastRun: r.jobsLastRun,
    missingLastRun: r.missingLastRun,
    overlapLastRun: r.overlapLastRun,
    consecutiveFailures: r.consecutiveFailures,
    needsBrowser: r.needsBrowser,
    reconNote: r.reconNote,
    reconnedAt: r.reconnedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    companies: r.companies.map((c) => ({ name: c.name, slug: c.slug })),
  }));

  return <BoardReadersView readers={readers} />;
}
