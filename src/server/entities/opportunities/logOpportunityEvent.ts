// The single write seam for Opportunity (lead) timeline events — mirror of
// entities/companies/logCompanyEvent and entities/jobs/logJobEvents. It
// inserts the OpportunityEvent, applies the lead status auto-cache, and stamps
// nextStepAt for a scheduled call, atomically. Was hand-rolled in three places
// (the log_opportunity_events tool, createOpportunities' seed events, and
// updateOpportunity's STATUS_CHANGED write).
//
// The OpportunityEvent log is the audit trail; Opportunity.status is its
// denormalized read for the dashboard and focus pill — so the event insert and
// the status flip must commit together. Works purely in ids; slug→id
// translation is the tool layer's job.

import {
  EventSource,
  OpportunityEventType,
  OpportunityStatus,
  type Prisma,
} from "@/generated/prisma/client";
import { bulkUpdate, type Database } from "@/server/db/bulkUpdate";
import { prisma } from "@/server/db/prisma";

// Lead-level status auto-cache (moved here from agent/tools/lib/opportunities.ts,
// which kept only the agent-facing enum LISTS). INBOUND_RECEIVED / NOTE /
// STATUS_CHANGED don't shift status — a STATUS_CHANGED is written by
// updateOpportunity when it sets the status directly, not derived from this map.
export const OPPORTUNITY_EVENT_TO_STATUS: Partial<
  Record<OpportunityEventType, OpportunityStatus>
> = {
  CALL_SCHEDULED: OpportunityStatus.SCREENING,
  CALL_HAPPENED: OpportunityStatus.SCREENING,
  NEXT_STEP_RECEIVED: OpportunityStatus.AWAITING,
  CLOSED: OpportunityStatus.CLOSED,
};

// True when the lead's cached status is the one this event type set — i.e.
// deleting that event would leave the denormalized status with no backing event.
// delete_opportunity_event uses it to flag (not auto-recompute) a stale status,
// mirroring statusBackedByEvent for jobs.
export function statusBackedByOpportunityEvent(
  status: OpportunityStatus,
  eventType: OpportunityEventType,
): boolean {
  const mapped = OPPORTUNITY_EVENT_TO_STATUS[eventType];
  return mapped != null && mapped === status;
}

export type LogOpportunityEventInput = {
  opportunityId: string;
  type: OpportunityEventType;
  occurredAt?: Date | null; // defaults to now
  notes?: string | null;
  source?: EventSource; // defaults to CHAT_EXTRACTED
};

export type LogOpportunityEventResult = {
  opportunityId: string;
  // Set only when the status auto-cache actually moved / nextStepAt was stamped,
  // so a caller can render "status → X" without re-reading the row.
  statusChangedTo?: OpportunityStatus;
  nextStepAtSetTo?: Date;
};

// A planned batch: what the writes WILL be, plus the results they produce. Same
// split as planJobEvents, for the same reason — a constant number of statements,
// and a caller with writes of its own runs `plan.write(tx)` inside its own
// transaction.
export type OpportunityEventPlan = {
  write: (tx: Prisma.TransactionClient) => Promise<void>;
  results: (LogOpportunityEventResult | null)[];
};

export async function planOpportunityEvents(
  userId: string,
  items: LogOpportunityEventInput[],
): Promise<OpportunityEventPlan> {
  if (items.length === 0) return { write: async () => {}, results: [] };

  // Ownership-scoped read of every referenced lead's current status, in one
  // query. A stray/unowned id simply has no row, which is what turns it into a
  // null result slot instead of FK-aborting the batch.
  const opps = await prisma.opportunity.findMany({
    where: {
      id: { in: [...new Set(items.map((i) => i.opportunityId))] },
      userId,
    },
    select: { id: true, status: true },
  });
  const statusById = new Map(opps.map((o) => [o.id, o.status]));

  const eventRows: Prisma.OpportunityEventCreateManyInput[] = [];
  const results: (LogOpportunityEventResult | null)[] = [];
  const patchById = new Map<string, Prisma.OpportunityUncheckedUpdateInput>();

  for (const item of items) {
    const priorStatus = statusById.get(item.opportunityId);
    if (priorStatus === undefined) {
      results.push(null);
      continue;
    }
    const occurredAt = item.occurredAt ?? new Date();
    eventRows.push({
      opportunityId: item.opportunityId,
      type: item.type,
      occurredAt,
      notes: item.notes ?? null,
      source: item.source ?? EventSource.CHAT_EXTRACTED,
    });

    const update: Prisma.OpportunityUncheckedUpdateInput = {};
    const nextStatus = OPPORTUNITY_EVENT_TO_STATUS[item.type];
    if (nextStatus && nextStatus !== priorStatus) update.status = nextStatus;
    if (item.type === OpportunityEventType.CALL_SCHEDULED)
      update.nextStepAt = occurredAt;
    if (Object.keys(update).length > 0) {
      patchById.set(item.opportunityId, {
        ...patchById.get(item.opportunityId),
        ...update,
      });
    }

    results.push({
      opportunityId: item.opportunityId,
      statusChangedTo: update.status as OpportunityStatus | undefined,
      nextStepAtSetTo: update.nextStepAt as Date | undefined,
    });
  }

  const write = async (tx: Prisma.TransactionClient): Promise<void> => {
    if (eventRows.length > 0) {
      await tx.opportunityEvent.createMany({ data: eventRows });
    }
    // Per-lead values differ (a scheduled call stamps its own nextStepAt), so
    // this is the one-statement bulk update rather than an update each.
    await bulkUpdate(
      "Opportunity",
      "id",
      [...patchById].map(([id, patch]) => ({
        key: id,
        patch: patch as Partial<Database["Opportunity"]>,
      })),
      tx,
    );
  };

  return { write, results };
}

// Batch form — every item in ONE transaction. Unknown/unowned ids resolve to a
// null slot.
export async function logOpportunityEvents(args: {
  userId: string;
  items: LogOpportunityEventInput[];
}): Promise<(LogOpportunityEventResult | null)[]> {
  if (args.items.length === 0) return [];
  const plan = await planOpportunityEvents(args.userId, args.items);
  await prisma.$transaction((tx) => plan.write(tx));
  return plan.results;
}

export async function logOpportunityEvent(args: {
  userId: string;
  item: LogOpportunityEventInput;
}): Promise<LogOpportunityEventResult | null> {
  const [result] = await logOpportunityEvents({
    userId: args.userId,
    items: [args.item],
  });
  return result;
}
