// By-id targeting + single-row edit/delete for CompanyEvents — the domain core
// behind the edit_company_event and delete_company_event tools. Parallel to
// jobEventEdits, minus the stale-status flag: a CompanyEvent backs the company
// "Recent activity" feed, not a cached status column, so deleting one can't
// strand a denormalized status. Ownership is enforced here (CompanyEvent carries
// its own userId).

import type { CompanyEventType } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

export type TargetCompanyEvent = {
  id: string;
  type: CompanyEventType;
  occurredAt: Date;
  notes: string | null;
  jobTitle: string | null;
};

// Resolve a CompanyEvent by its id, scoped to the user. A stray / other-user id
// resolves to null rather than leaking or throwing.
export async function getCompanyEventById(
  userId: string,
  eventId: string,
): Promise<TargetCompanyEvent | null> {
  return await prisma.companyEvent.findFirst({
    where: { id: eventId, userId },
    select: {
      id: true,
      type: true,
      occurredAt: true,
      notes: true,
      jobTitle: true,
    },
  });
}

export async function editCompanyEvent(
  eventId: string,
  data: { occurredAt?: Date; notes?: string },
): Promise<void> {
  await prisma.companyEvent.update({
    where: { id: eventId },
    data,
    select: { id: true },
  });
}

export async function deleteCompanyEvent(eventId: string): Promise<void> {
  await prisma.companyEvent.delete({ where: { id: eventId } });
}
