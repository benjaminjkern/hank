// By-id targeting + single-row edit/delete for already-logged JobEvents — the
// domain core behind the edit_job_event and delete_job_event tools. The agent
// gets the event's id from list_job_events, then names it directly, so there's
// no "most recent of this type" latching (which silently grabbed the wrong row
// when a job had several events of the same type). Ownership is enforced here:
// the lookup only resolves an event whose JobInteraction belongs to the user.

import type {
  JobEventType,
  JobInteractionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

export type TargetJobEvent = {
  id: string;
  type: JobEventType;
  occurredAt: Date;
};

export type GetJobEventResult =
  | {
      kind: "ok";
      jobInteractionStatus: JobInteractionStatus;
      event: TargetJobEvent;
    }
  | { kind: "not_found" };

// Resolve a JobEvent by its id, scoped to the user (via the parent JobInteraction).
// A stray / other-user id resolves to not_found rather than leaking or throwing.
export async function getJobEventById(
  userId: string,
  eventId: string,
): Promise<GetJobEventResult> {
  const ev = await prisma.jobEvent.findFirst({
    where: { id: eventId, jobInteraction: { userId } },
    select: {
      id: true,
      type: true,
      occurredAt: true,
      jobInteraction: { select: { status: true } },
    },
  });
  if (!ev) return { kind: "not_found" };
  return {
    kind: "ok",
    jobInteractionStatus: ev.jobInteraction.status,
    event: { id: ev.id, type: ev.type, occurredAt: ev.occurredAt },
  };
}

export async function editJobEvent(
  eventId: string,
  data: { occurredAt?: Date; notes?: string },
): Promise<void> {
  await prisma.jobEvent.update({
    where: { id: eventId },
    data,
    select: { id: true },
  });
}

export async function deleteJobEvent(eventId: string): Promise<void> {
  await prisma.jobEvent.delete({ where: { id: eventId } });
}
