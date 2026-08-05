// Per-company job listing — the query behind the list_jobs tool. No default
// status filter: omitting `statuses` lists every status, so a lookup never
// misses a closed/deferred role.
//
// Windowed rather than paged: which window, and how the "more pages" line
// reads, belong to the channel asking — see tools/lib/paginate.ts.

import type {
  JobInteractionStatus,
  JobCloseReason,
  Prisma,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

export type CompanyJobRow = {
  status: JobInteractionStatus;
  closeReason: JobCloseReason | null;
  jobId: string;
  jobSlug: string | null;
  jobTitle: string;
};

export function companyJobsQuery(args: {
  userId: string;
  companyId: string;
  titleFilter?: string;
  statuses?: JobInteractionStatus[];
}) {
  const where: Prisma.JobInteractionWhereInput = {
    userId: args.userId,
    ...(args.statuses && args.statuses.length > 0
      ? { status: { in: args.statuses } }
      : {}),
    job: {
      companyId: args.companyId,
      ...(args.titleFilter
        ? { title: { contains: args.titleFilter, mode: "insensitive" } }
        : {}),
    },
  };
  return {
    count: () => prisma.jobInteraction.count({ where }),
    rows: async ({
      skip,
      take,
    }: {
      skip: number;
      take: number;
    }): Promise<CompanyJobRow[]> => {
      const rows = await prisma.jobInteraction.findMany({
        where,
        include: { job: { select: { id: true, slug: true, title: true } } },
        // Stable order so paging forward doesn't skip/repeat rows on equal
        // updatedAt: most-recently-updated first, tiebroken by id.
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip,
        take,
      });
      return rows.map((r) => ({
        status: r.status,
        closeReason: r.closeReason,
        jobId: r.job.id,
        jobSlug: r.job.slug,
        jobTitle: r.job.title,
      }));
    },
  };
}
