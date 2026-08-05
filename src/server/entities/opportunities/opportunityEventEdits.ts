// By-id targeting + single-row edit/delete for OpportunityEvents — the domain
// core behind the edit_opportunity_event and delete_opportunity_event tools.
// Parallel to jobEventEdits: the lookup returns the lead's cached status so
// delete can flag (not auto-recompute) a now-stale status, exactly like the job
// path. Ownership is enforced via the parent Opportunity's userId.

import type {
  OpportunityEventType,
  OpportunityStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

export type TargetOpportunityEvent = {
  id: string;
  type: OpportunityEventType;
  occurredAt: Date;
  notes: string | null;
};

export type GetOpportunityEventResult =
  | {
      kind: "ok";
      opportunityStatus: OpportunityStatus;
      event: TargetOpportunityEvent;
    }
  | { kind: "not_found" };

// Resolve an OpportunityEvent by its id, scoped to the user (via the parent
// opportunity). A stray / other-user id resolves to not_found.
export async function getOpportunityEventById(
  userId: string,
  eventId: string,
): Promise<GetOpportunityEventResult> {
  const ev = await prisma.opportunityEvent.findFirst({
    where: { id: eventId, opportunity: { userId } },
    select: {
      id: true,
      type: true,
      occurredAt: true,
      notes: true,
      opportunity: { select: { status: true } },
    },
  });
  if (!ev) return { kind: "not_found" };
  return {
    kind: "ok",
    opportunityStatus: ev.opportunity.status,
    event: {
      id: ev.id,
      type: ev.type,
      occurredAt: ev.occurredAt,
      notes: ev.notes,
    },
  };
}

export async function editOpportunityEvent(
  eventId: string,
  data: { occurredAt?: Date; notes?: string },
): Promise<void> {
  await prisma.opportunityEvent.update({
    where: { id: eventId },
    data,
    select: { id: true },
  });
}

export async function deleteOpportunityEvent(eventId: string): Promise<void> {
  await prisma.opportunityEvent.delete({ where: { id: eventId } });
}
