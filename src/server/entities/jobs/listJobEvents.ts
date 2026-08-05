// Per-role event listing — the read counterpart to log_job_events /
// edit_job_event / delete_job_event. Two exports because they answer two
// questions: `loadJobEventHeader` is the role this history belongs to (and
// whether it's tracked at all), `jobEventsQuery` is the events themselves.
//
// The query is windowed rather than paged: which window, and how the "more
// pages" line reads, belong to the channel asking — see tools/lib/paginate.ts.
// Each row carries its id so the agent can target it for edit/delete.

import type {
  JobInteractionStatus,
  JobCloseReason,
  JobDeferReason,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

export type JobEventHeader = {
  jobInteractionId: string;
  status: JobInteractionStatus;
  closeReason: JobCloseReason | null;
  closeNote: string | null;
  deferReason: JobDeferReason | null;
  deferNote: string | null;
  title: string;
  companyName: string;
};

// null when the job has no tracked JobInteraction — nothing has been logged for
// it yet, which is a different answer from "tracked, but no events".
export async function loadJobEventHeader(
  userId: string,
  jobId: string,
): Promise<JobEventHeader | null> {
  const row = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId, jobId } },
    select: {
      id: true,
      status: true,
      closeReason: true,
      closeNote: true,
      deferReason: true,
      deferNote: true,
      job: {
        select: {
          title: true,
          companyName: true,
          company: { select: { name: true } },
        },
      },
    },
  });
  if (!row) return null;
  return {
    jobInteractionId: row.id,
    status: row.status,
    closeReason: row.closeReason,
    closeNote: row.closeNote,
    deferReason: row.deferReason,
    deferNote: row.deferNote,
    title: row.job?.title ?? "(unknown role)",
    companyName:
      row.job?.company?.name ?? row.job?.companyName ?? "(unknown company)",
  };
}

export function jobEventsQuery(jobInteractionId: string) {
  const where = { jobInteractionId };
  return {
    count: () => prisma.jobEvent.count({ where }),
    rows: ({ skip, take }: { skip: number; take: number }) =>
      prisma.jobEvent.findMany({
        where,
        // Newest-first, tiebroken by id so paging is stable on equal occurredAt.
        orderBy: [{ occurredAt: "desc" as const }, { id: "asc" as const }],
        skip,
        take,
        select: {
          id: true,
          type: true,
          occurredAt: true,
          notes: true,
          source: true,
        },
      }),
  };
}
