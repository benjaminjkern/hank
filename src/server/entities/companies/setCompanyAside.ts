// The four ways a company stops being the thing you're working on: closed,
// blocked, paused, caught up. Each is a single coherent state change, and each
// returns FACTS — no prose, no UI events. How it reads is the caller's: the tool
// writes Hank-facing content, the walkthrough narrates to the user, and those
// are different audiences (see procedures/registry/walkthrough/narration.ts).
//
// Every write goes through `companyStatusFields()` so the clear-on-transition
// rule can't be hand-rolled wrong, and every company-feed row through
// `logCompanyEvent`.
//
// None of these wraps the segment. Ending a company only REPORTS that it ended;
// consolidate + compact is procedures/registry/wrapCompanySegment.ts, which the
// chat runner invokes once per message.

import {
  type CompanyBlockReason,
  type CompanyCloseReason,
  CompanyEventType,
  type CompanyPauseReason,
  CompanyStatus,
  JobCloseReason,
  JobEventType,
  JobInteractionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { planJobEvents } from "@/server/entities/jobs/logJobEvents";

import { companyStatusFields } from "./companyStatusFields";
import { computeCompanyEngagement } from "./engagement";
import {
  humanCompanyBlockReason,
  humanCompanyCloseReason,
  humanCompanyPauseReason,
} from "./humanCompanyReasonLabels";
import { logCompanyEvent } from "./logCompanyEvent";

// Set every NEW / SCANNED / SHORTLISTED job at the company to CLOSED with
// reason=OTHER and a closeNote naming the parent close, then set the company
// CLOSED. DEFERRED jobs stay paused (the user explicitly paused them; we don't
// auto-skip those). APPLIED+ are terminal and unaffected.
export async function closeCompany(args: {
  userId: string;
  companyId: string;
  reason: CompanyCloseReason;
  note?: string;
}): Promise<{ closedJobCount: number }> {
  const now = new Date();
  const companyName = await getCompanyName(args.companyId);
  const jobsNote = args.note
    ? `Company ${companyName ?? args.companyId} skipped (${args.reason}): ${args.note}`
    : `Company ${companyName ?? args.companyId} skipped (${args.reason})`;

  const openJobs = await prisma.jobInteraction.findMany({
    where: {
      userId: args.userId,
      job: { companyId: args.companyId },
      status: {
        in: [
          JobInteractionStatus.NEW,
          JobInteractionStatus.SCANNED,
          JobInteractionStatus.SHORTLISTED,
        ],
      },
    },
    select: { id: true, jobId: true },
  });

  // Per-role CLOSED via the shared primitive (status flip + backing event).
  // CLOSED doesn't dual-write per role — the swept roles collapse to the single
  // JOBS_CLOSED summary company event below.
  const plan = await planJobEvents(
    args.userId,
    openJobs.map((j) => ({
      jobId: j.jobId,
      type: JobEventType.CLOSED,
      occurredAt: now,
      notes: jobsNote,
      jobInteractionUpdate: {
        status: JobInteractionStatus.CLOSED,
        closeReason: JobCloseReason.OTHER,
        closeNote: jobsNote,
        deferReason: null,
        deferNote: null,
      },
    })),
  );

  // The role sweep and the company flip commit together — hence planJobEvents
  // rather than logJobEvents, which would open a transaction of its own. Constant
  // statement count whatever the board size.
  await prisma.$transaction(async (tx) => {
    await plan.write(tx);
    await tx.companyInteraction.update({
      where: {
        userId_companyId: { userId: args.userId, companyId: args.companyId },
      },
      data: companyStatusFields({
        status: CompanyStatus.CLOSED,
        closeReason: args.reason,
        closeNote: args.note,
      }),
    });
  });

  // Company feed: one summary for the swept roles + the company-status row.
  // Best-effort (no tx) — a feed write must never block the close.
  if (openJobs.length > 0) {
    await logCompanyEvent({
      userId: args.userId,
      companyId: args.companyId,
      type: CompanyEventType.JOBS_CLOSED,
      occurredAt: now,
      notes: `Closed ${openJobs.length} open role${openJobs.length === 1 ? "" : "s"} (company closed: ${humanCompanyCloseReason(args.reason)})`,
    });
  }
  await logCompanyEvent({
    userId: args.userId,
    companyId: args.companyId,
    type: CompanyEventType.CLOSED,
    occurredAt: now,
    notes: `${humanCompanyCloseReason(args.reason)}${args.note ? `: ${args.note.trim()}` : ""}`,
  });

  return { closedJobCount: openJobs.length };
}

// A *technical* set-aside ("couldn't read the board"), NOT a judgment about fit.
// Deliberately does NOT bulk-close the company's jobs the way closeCompany does
// — being unable to read the board says nothing about any role. Revive re-hunts.
export async function blockCompany(args: {
  userId: string;
  companyId: string;
  reason: CompanyBlockReason;
  note?: string;
}): Promise<void> {
  await prisma.companyInteraction.update({
    where: {
      userId_companyId: { userId: args.userId, companyId: args.companyId },
    },
    data: companyStatusFields({
      status: CompanyStatus.BLOCKED,
      blockReason: args.reason,
      blockNote: args.note,
    }),
  });
  await logCompanyEvent({
    userId: args.userId,
    companyId: args.companyId,
    type: CompanyEventType.BLOCKED,
    notes: `${humanCompanyBlockReason(args.reason)}${args.note ? `: ${args.note.trim()}` : ""}`,
  });
}

// "Started but deliberately not working it right now." No revisit timer — the
// row stays PAUSED (and excluded from scans) until explicitly revived.
export async function pauseCompany(args: {
  userId: string;
  companyId: string;
  reason: CompanyPauseReason;
  note?: string;
}): Promise<void> {
  await prisma.companyInteraction.update({
    where: {
      userId_companyId: { userId: args.userId, companyId: args.companyId },
    },
    data: companyStatusFields({
      status: CompanyStatus.PAUSED,
      pauseReason: args.reason,
      pauseNote: args.note,
    }),
  });
  await logCompanyEvent({
    userId: args.userId,
    companyId: args.companyId,
    type: CompanyEventType.PAUSED,
    notes: `${humanCompanyPauseReason(args.reason)}${args.note ? `: ${args.note.trim()}` : ""}`,
  });
}

// No open-roles gate here: the caller owns it — the walkthrough state machine has
// already verified nothing is mid-flight, and the caught_up_company tool bails to
// a confirmation of its own.
//
// Returns the status that actually landed, which is not always CAUGHT_UP: with
// `derive`, a round that ended with applications out lands IN_FLIGHT /
// IN_PROCESS. The caller needs it to phrase the outcome honestly.
export async function caughtUpCompany(args: {
  userId: string;
  companyId: string;
  // True for the deterministic walkthrough wrap — DERIVE the tail status from the
  // company's job pipeline instead of forcing CAUGHT_UP. The explicit chat
  // callers keep the default (false): an explicit "mark caught up" respects the
  // user's word, and a later job event re-derives if it drifts.
  derive?: boolean;
}): Promise<{ status: CompanyStatus }> {
  const status =
    args.derive === true
      ? await computeCompanyEngagement(args.userId, args.companyId)
      : CompanyStatus.CAUGHT_UP;
  await prisma.companyInteraction.update({
    where: {
      userId_companyId: { userId: args.userId, companyId: args.companyId },
    },
    data: companyStatusFields({ status }),
  });
  // Only CAUGHT_UP is an explicit company event. IN_FLIGHT / IN_PROCESS are the
  // auto engagement tail — already implied by the per-role APPLIED/RESPONDED rows
  // on the feed, so they don't get their own event (refreshCompanyEngagement
  // writes none either).
  if (status === CompanyStatus.CAUGHT_UP) {
    await logCompanyEvent({
      userId: args.userId,
      companyId: args.companyId,
      type: CompanyEventType.CAUGHT_UP,
      notes: "Caught up — nothing actionable right now.",
    });
  }
  return { status };
}

async function getCompanyName(companyId: string): Promise<string | null> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true },
  });
  return c?.name ?? null;
}
