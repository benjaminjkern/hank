// Per-lead event listing — the read counterpart to log_opportunity_events /
// edit_opportunity_event / delete_opportunity_event. Two exports, mirroring
// listJobEvents: the lead this history belongs to (and whether it's the user's
// at all), then the events themselves.
//
// Windowed rather than paged: which window, and how the "more pages" line
// reads, belong to the channel asking — see tools/lib/paginate.ts.

import type { OpportunityStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

export type OpportunityEventHeader = {
  opportunityId: string;
  status: OpportunityStatus;
  label: string;
};

// null when the opportunity doesn't exist / isn't the user's.
export async function loadOpportunityEventHeader(
  userId: string,
  opportunityId: string,
): Promise<OpportunityEventHeader | null> {
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, userId },
    select: { id: true, status: true, label: true },
  });
  if (!opp) return null;
  return { opportunityId: opp.id, status: opp.status, label: opp.label };
}

export function opportunityEventsQuery(opportunityId: string) {
  const where = { opportunityId };
  return {
    count: () => prisma.opportunityEvent.count({ where }),
    rows: ({ skip, take }: { skip: number; take: number }) =>
      prisma.opportunityEvent.findMany({
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
