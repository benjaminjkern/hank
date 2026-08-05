// The single write seam for JobInteraction timeline events — "make sure the
// JobInteraction exists, create its JobEvent, dual-write the per-role
// CompanyEvent, and flip the cached status". Never hand-roll this pair at a call
// site. Mirror of entities/companies/logCompanyEvent.
//
// Atomicity is the whole point: events are the audit trail and status is its
// denormalized cache, so the event insert + the status flip + the company
// dual-write MUST commit together (a mid-flight Stop abort between them would
// strand a CLOSED status with no event, or an APPLIED event on a SHORTLISTED
// row). Derived, idempotent work (engagement recompute, focus clearing, nextJob
// lookup) stays with the caller — it's not part of the atomic write.
//
// A CONSTANT number of statements, not a number that grows with the batch. This
// used to run `for (item of items) { upsert; insert; update }` inside an
// interactive transaction — three sequential round trips per item against a
// remote Postgres at ~35-40ms each — so a pre-scan closing 26 roles needed >10s
// and died on the transaction timeout, rolling back all 26 closes. (Prisma's
// `$transaction([...])` does NOT fix that: it reads like a batch but still
// issues one round trip per operation. See db/bulkUpdate.ts for the numbers.)
//
// So: read the whole batch's prior state in two queries, decide everything in
// JS, then write it as at most four statements — seed missing interactions,
// insert the events, `bulkUpdate` the status flips (per-row values in ONE
// statement), insert the company milestones.
//
// The read is deliberately OUTSIDE the transaction. Its only consumers are the
// prior-status comparison and `computeExtraUpdate`, and a run holds its session
// exclusively (claimSessionForNewRun), so nothing else is moving these rows
// mid-batch. Re-reading them inside the write is what cost three round trips.

import {
  EventSource,
  JobEventType,
  JobInteractionStatus,
  JobCloseReason,
  type Prisma,
} from "@/generated/prisma/client";
import { bulkUpdate, type Database } from "@/server/db/bulkUpdate";
import { prisma } from "@/server/db/prisma";
import {
  logCompanyEvents,
  type CompanyEventInput,
} from "@/server/entities/companies/logCompanyEvent";

import { EVENT_TO_STATUS, DUAL_WRITE_COMPANY_EVENT } from "./jobEventStatus";

// The JobInteraction fields a caller might read to compute its specialization
// (markJobApplied reads opportunityId to pick the apply channel).
export type LoggedJobInteraction = {
  status: JobInteractionStatus;
  opportunityId: string | null;
  companyId: string | null;
  jobTitle: string | null;
};

export type LogJobEventInput = {
  jobId: string;
  type: JobEventType;
  occurredAt?: Date | null; // defaults to now
  notes?: string | null;
  source?: EventSource; // defaults to CHAT_EXTRACTED
  // How to update the cached JobInteraction alongside the event:
  //  - "auto" (default): derive the status from EVENT_TO_STATUS[type] and set it
  //    when it changed; a WITHDRAWN event also stamps closeReason=WITHDRAWN.
  //  - an object: force these fields verbatim (status + reason/note/applyChannel,
  //    including the clear-on-transition nulls) — used by close/defer/applied.
  jobInteractionUpdate?: "auto" | Prisma.JobInteractionUncheckedUpdateInput;
  // Extra update fields computed from the pre-update JobInteraction — markJobApplied
  // needs opportunityId to default the apply channel. Merged into (and overrides)
  // jobInteractionUpdate.
  computeExtraUpdate?: (
    jobInteraction: LoggedJobInteraction,
  ) => Prisma.JobInteractionUncheckedUpdateInput;
  // Dual-write a per-role CompanyEvent. Defaults to whether the event type is in
  // DUAL_WRITE_COMPANY_EVENT; pass false to suppress.
  dualWrite?: boolean;
};

export type LogJobEventResult = {
  jobId: string;
  companyId: string | null;
  jobTitle: string | null;
  priorStatus: JobInteractionStatus;
  // The JobInteraction as it was BEFORE this event's update (what computeExtraUpdate
  // saw). Callers that surfaced draft-wipe details read it here.
  jobInteraction: LoggedJobInteraction;
  // Set only when the status actually changed / a close reason was stamped, so a
  // caller can render "status → X, closeReason → Y" without re-reading the row.
  statusChangedTo?: JobInteractionStatus;
  closeReasonSetTo?: JobCloseReason;
};

// A planned batch: what the writes WILL be, plus the results they produce
// (derived entirely from the pre-read, so nothing here needs the DB's response).
// Splitting plan from execute is what lets a caller with writes of its own —
// closing a company also flips the company row — run everything in ONE
// transaction instead of nesting transactions or paying a second round trip.
export type JobEventPlan = {
  // Runs the batch's writes on the caller's transaction handle. Constant
  // statement count; safe to call inside an existing `$transaction`.
  write: (tx: Prisma.TransactionClient) => Promise<void>;
  results: LogJobEventResult[];
};

export async function planJobEvents(
  userId: string,
  items: LogJobEventInput[],
): Promise<JobEventPlan> {
  if (items.length === 0) return { write: async () => {}, results: [] };
  const jobIds = [...new Set(items.map((i) => i.jobId))];

  // Both reads at once: the interactions carry prior status/opportunity + the id
  // the status flip keys on, the jobs carry company/title (needed for rows that
  // have no interaction yet, so it can't come from a join).
  const [priorRows, jobRows] = await Promise.all([
    prisma.jobInteraction.findMany({
      where: { userId, jobId: { in: jobIds } },
      select: { id: true, jobId: true, status: true, opportunityId: true },
    }),
    prisma.job.findMany({
      where: { id: { in: jobIds } },
      select: { id: true, companyId: true, title: true },
    }),
  ]);
  const priorByJobId = new Map(priorRows.map((r) => [r.jobId, r]));
  const jobById = new Map(jobRows.map((j) => [j.id, j]));

  const missingJobIds = jobIds.filter((id) => !priorByJobId.has(id));
  const companyEventRows: CompanyEventInput[] = [];
  const results: LogJobEventResult[] = [];
  // jobId -> the patch its status flip applies. Resolved to interaction ids at
  // write time, because a seeded row's id isn't known until it's inserted.
  const patchByJobId = new Map<
    string,
    Prisma.JobInteractionUncheckedUpdateInput
  >();
  const eventRows: Array<{
    jobId: string;
    type: JobEventType;
    occurredAt: Date;
    notes: string | null;
    source: EventSource;
  }> = [];

  for (const item of items) {
    const prior = priorByJobId.get(item.jobId);
    const job = jobById.get(item.jobId);
    const jobInteraction: LoggedJobInteraction = {
      status: prior?.status ?? JobInteractionStatus.NEW,
      opportunityId: prior?.opportunityId ?? null,
      companyId: job?.companyId ?? null,
      jobTitle: job?.title ?? null,
    };
    const occurredAt = item.occurredAt ?? new Date();

    eventRows.push({
      jobId: item.jobId,
      type: item.type,
      occurredAt,
      notes: item.notes ?? null,
      source: item.source ?? EventSource.CHAT_EXTRACTED,
    });

    // Per-role company milestone, collected and written as one insert at the end
    // of the batch — still inside the same transaction, so it can't strand
    // without its JobEvent. No-op when companyId is null.
    const companyEventType = DUAL_WRITE_COMPANY_EVENT[item.type];
    const shouldDualWrite = item.dualWrite ?? !!companyEventType;
    if (shouldDualWrite && companyEventType && jobInteraction.companyId) {
      companyEventRows.push({
        userId,
        companyId: jobInteraction.companyId,
        type: companyEventType,
        occurredAt,
        notes: item.notes ?? undefined,
        jobId: item.jobId,
        jobTitle: jobInteraction.jobTitle,
        source: item.source ?? EventSource.CHAT_EXTRACTED,
      });
    }

    // Build the JobInteraction update. "auto" derives from the status map (and the
    // WITHDRAWN close-reason special case); an explicit object forces the fields.
    const update: Prisma.JobInteractionUncheckedUpdateInput =
      item.jobInteractionUpdate && item.jobInteractionUpdate !== "auto"
        ? { ...item.jobInteractionUpdate }
        : {};
    if (!item.jobInteractionUpdate || item.jobInteractionUpdate === "auto") {
      const nextStatus = EVENT_TO_STATUS[item.type];
      if (nextStatus && nextStatus !== jobInteraction.status)
        update.status = nextStatus;
      if (item.type === JobEventType.WITHDRAWN) {
        update.closeReason = JobCloseReason.WITHDRAWN;
      }
    }
    if (item.computeExtraUpdate)
      Object.assign(update, item.computeExtraUpdate(jobInteraction));

    // Stance clear-on-transition: a status change ends whatever the shortlist
    // board proposed for this row — the stance belongs to the negotiation the old
    // status was part of. Board writers that manage the stance themselves (the
    // commit) pass proposed* fields explicitly, which suppresses the default.
    if (update.status !== undefined && !("proposedVerdict" in update)) {
      update.proposedVerdict = null;
      update.placementVerdict = null;
      update.proposedReason = null;
      update.proposedBy = null;
      update.proposedAt = null;
    }

    if (Object.keys(update).length > 0) {
      // Two events on the same role in one batch merge into one flip — the last
      // one wins, which is the order they were applied in anyway.
      patchByJobId.set(item.jobId, {
        ...patchByJobId.get(item.jobId),
        ...update,
      });
    }

    results.push({
      jobId: item.jobId,
      companyId: jobInteraction.companyId,
      jobTitle: jobInteraction.jobTitle,
      priorStatus: jobInteraction.status,
      jobInteraction,
      statusChangedTo: update.status as JobInteractionStatus | undefined,
      closeReasonSetTo: update.closeReason as JobCloseReason | undefined,
    });
  }

  const write = async (tx: Prisma.TransactionClient): Promise<void> => {
    // Statement 1 — seed any interaction that doesn't exist yet, and learn its
    // id in the same statement so the event insert below has a FK to point at.
    const interactionIdByJobId = new Map(
      priorRows.map((r) => [r.jobId, r.id] as const),
    );
    if (missingJobIds.length > 0) {
      const seeded = await tx.jobInteraction.createManyAndReturn({
        data: missingJobIds.map((jobId) => ({
          userId,
          jobId,
          status: JobInteractionStatus.NEW,
        })),
        select: { id: true, jobId: true },
      });
      for (const row of seeded) interactionIdByJobId.set(row.jobId, row.id);
    }

    // Statement 2 — every event in the batch.
    await tx.jobEvent.createMany({
      data: eventRows.map((e) => ({
        jobInteractionId: interactionIdByJobId.get(e.jobId)!,
        type: e.type,
        occurredAt: e.occurredAt,
        notes: e.notes,
        source: e.source,
      })),
    });

    // Statement 3 — every status flip, each with its OWN values, in one UPDATE.
    // This is the one Prisma can't express and the reason bulkUpdate exists.
    await bulkUpdate(
      "JobInteraction",
      "id",
      [...patchByJobId].map(([jobId, patch]) => ({
        key: interactionIdByJobId.get(jobId)!,
        patch: patch as Partial<Database["JobInteraction"]>,
      })),
      tx,
    );

    // Statement 4 — the per-role company milestones.
    await logCompanyEvents(companyEventRows, tx);
  };

  return { write, results };
}

// Batch form — every item in ONE transaction (the all-or-nothing semantics
// log_job_events relies on). A caller with writes of its own to commit alongside
// these calls planJobEvents and runs `plan.write(tx)` inside its own
// transaction, rather than passing a `tx` in here.
export async function logJobEvents(args: {
  userId: string;
  items: LogJobEventInput[];
}): Promise<LogJobEventResult[]> {
  if (args.items.length === 0) return [];
  const plan = await planJobEvents(args.userId, args.items);
  await prisma.$transaction((tx) => plan.write(tx));
  return plan.results;
}

// Single-item convenience for the specialized callers (close/defer/applied).
export async function logJobEvent(args: {
  userId: string;
  item: LogJobEventInput;
}): Promise<LogJobEventResult> {
  const [result] = await logJobEvents({
    userId: args.userId,
    items: [args.item],
  });
  return result;
}
