// Domain core for editing an inbound lead's (Opportunity's) lead-level fields.
// Shared behind the update_opportunity tool: applies a partial patch and, when
// the status actually changes, emits a STATUS_CHANGED timeline event in the same
// transaction so a Stop abort (or any error) between them can't leave the lead's
// status changed with no backing event. (Event-based transitions go through
// log_opportunity_event and emit their own events.)
//
// Works purely in ids — translating the agent's slugs → ids is the tool layer's
// job. Patch semantics per field: `undefined` = leave unchanged, `null` = clear.

import {
  OpportunityEventType,
  type OpportunityStatus,
  type Prisma,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { planOpportunityEvents } from "./logOpportunityEvent";

export type UpdateOpportunityPatch = {
  label?: string;
  status?: OpportunityStatus;
  // undefined = leave unchanged; null = disconnect; id = connect.
  primaryContactId?: string | null;
  nextStepAt?: Date | null;
  notes?: string;
  closedReason?: string;
  sourceJobInteractionId?: string | null;
};

export type UpdateOpportunityResult =
  { ok: true; changedFields: string[] } | { ok: false; reason: "not_found" };

export async function updateOpportunity(args: {
  userId: string;
  opportunityId: string;
  patch: UpdateOpportunityPatch;
}): Promise<UpdateOpportunityResult> {
  const { userId, opportunityId, patch } = args;

  const existing = await prisma.opportunity.findFirst({
    where: { id: opportunityId, userId },
    select: { id: true, status: true },
  });
  if (!existing) return { ok: false, reason: "not_found" };

  const data: Prisma.OpportunityUpdateInput = {};
  const changedFields: string[] = [];
  if (patch.label !== undefined) {
    data.label = patch.label;
    changedFields.push("label");
  }
  if (patch.status !== undefined) {
    data.status = patch.status;
    changedFields.push("status");
  }
  if (patch.primaryContactId !== undefined) {
    data.primaryContact = patch.primaryContactId
      ? { connect: { id: patch.primaryContactId } }
      : { disconnect: true };
    changedFields.push("primaryContact");
  }
  if (patch.nextStepAt !== undefined) {
    data.nextStepAt = patch.nextStepAt;
    changedFields.push("nextStepAt");
  }
  if (patch.notes !== undefined) {
    data.notes = patch.notes;
    changedFields.push("notes");
  }
  if (patch.closedReason !== undefined) {
    data.closedReason = patch.closedReason;
    changedFields.push("closedReason");
  }
  if (patch.sourceJobInteractionId !== undefined) {
    data.sourceJobInteraction = patch.sourceJobInteractionId
      ? { connect: { id: patch.sourceJobInteractionId } }
      : { disconnect: true };
    changedFields.push("sourceJob");
  }

  if (changedFields.length === 0) return { ok: true, changedFields };

  // Audit a direct status set via the single OpportunityEvent seam.
  // STATUS_CHANGED isn't in the auto-cache map, so it records without moving the
  // status (the patch below sets it). Planned rather than logged so both writes
  // land in one batched transaction.
  const plan =
    patch.status && patch.status !== existing.status
      ? await planOpportunityEvents(userId, [
          {
            opportunityId,
            type: OpportunityEventType.STATUS_CHANGED,
            notes: `${existing.status} → ${patch.status}`,
          },
        ])
      : null;

  await prisma.$transaction(async (tx) => {
    await tx.opportunity.update({ where: { id: opportunityId }, data });
    await plan?.write(tx);
  });

  return { ok: true, changedFields };
}
