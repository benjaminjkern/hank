// Per-company event listing — the read counterpart to log_company_events /
// edit_company_event / delete_company_event. Reads the same CompanyEvent feed
// the company "Recent activity" card renders, and returns each row's id so the
// agent can target it for edit/delete.
//
// Windowed rather than paged: which window, and how the "more pages" line
// reads, belong to the channel asking — see tools/lib/paginate.ts.

import { prisma } from "@/server/db/prisma";

export function companyEventsQuery(userId: string, companyId: string) {
  const where = { userId, companyId };
  return {
    count: () => prisma.companyEvent.count({ where }),
    rows: ({ skip, take }: { skip: number; take: number }) =>
      prisma.companyEvent.findMany({
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
          jobTitle: true,
          source: true,
        },
      }),
  };
}
