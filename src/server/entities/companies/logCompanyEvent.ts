// The single write seam for the CompanyEvent timeline (parallel to logJobEvents
// for JobEvent). Every company-feed row — batch summaries (JOBS_CLOSED /
// SCRAPE_FOUND / SHORTLIST_RAN), per-role milestone dual-writes, and company
// status changes — goes through here.
//
// Two usage modes:
//   * Milestone dual-writes pass `db: tx` so the CompanyEvent lands in the SAME
//     $transaction as the primary JobEvent+status write (a consistent audit
//     feed; a helper bug rolls back with the primary write instead of stranding
//     it). Keep this a thin insert so it can never be the thing that breaks an
//     apply/close.
//   * Summary + company-status seams call it best-effort AFTER their mutation
//     (no `db`) — a feed-write failure must never block the underlying state
//     change, so those callers swallow errors.
//
// companyId is nullable: agency / recruiter-pitched jobs have no watchlisted
// company, so there is no company feed to write — those callers get a silent
// no-op instead of a guard at every site.

import { CompanyEventType, EventSource } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

// Agent-facing list of company event types the log_company_events tool offers.
// Fully open — the agent can log ANY type (batch summaries, per-role milestones,
// status changes), no gating. Parallel to LOG_JOB_EVENT_TYPES for jobs.
export const LOG_COMPANY_EVENT_TYPES = Object.values(CompanyEventType) as [
  CompanyEventType,
  ...CompanyEventType[],
];

export type CompanyEventInput = {
  userId: string;
  companyId: string | null;
  type: CompanyEventType;
  occurredAt?: Date;
  notes?: string | null;
  source?: EventSource;
  jobId?: string | null;
  jobTitle?: string | null;
};

export async function logCompanyEvent(
  args: CompanyEventInput & { db?: Db },
): Promise<void> {
  if (!args.companyId) return; // no watchlisted company ⇒ no feed
  const db = args.db ?? prisma;
  await db.companyEvent.create({
    data: {
      userId: args.userId,
      companyId: args.companyId,
      type: args.type,
      occurredAt: args.occurredAt ?? new Date(),
      notes: args.notes ?? null,
      source: args.source ?? EventSource.CHAT_EXTRACTED,
      jobId: args.jobId ?? null,
      jobTitle: args.jobTitle ?? null,
    },
  });
}

// Batch variant — one INSERT for any number of rows. Rows with a null companyId
// are dropped. Pass `db` to enlist in a caller's transaction.
export async function logCompanyEvents(
  rows: CompanyEventInput[],
  db: Db = prisma,
): Promise<void> {
  const data = rows
    .filter((r) => r.companyId)
    .map((r) => ({
      userId: r.userId,
      companyId: r.companyId as string,
      type: r.type,
      occurredAt: r.occurredAt ?? new Date(),
      notes: r.notes ?? null,
      source: r.source ?? EventSource.CHAT_EXTRACTED,
      jobId: r.jobId ?? null,
      jobTitle: r.jobTitle ?? null,
    }));
  if (data.length === 0) return;
  await db.companyEvent.createMany({ data });
}
