// The canonical APPLIED write — shared by the `mark_job_applied` tool (agent /
// historical entry) and the drafting widget's submit button. One place for the
// applyChannel default + nextJobId surfacing.
//
// This is the SINGLE write for "applied": the agent's `log_job_events` tool
// refuses APPLIED so it can't take a second path.

import {
  ApplyChannel,
  JobEventType,
  JobInteractionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { refreshCompanyEngagement } from "@/server/entities/companies/engagement";
import { logJobEvent } from "@/server/entities/jobs/logJobEvents";

type MarkJobAppliedArgs = {
  userId: string;
  jobId: string;
  occurredAt?: Date;
  applyChannel?: ApplyChannel;
  notes?: string;
};

// Facts only. The two callers phrase this for different audiences — the tool
// writes Hank-facing content, the walkthrough narrates to the user — so neither
// a shared sentence nor a shared UiEvent belongs here.
export type MarkJobAppliedResult = {
  jobId: string;
  jobTitle: string | null;
  companyId: string | null;
  appliedAt: Date;
  // Resolved here (not by the caller) because the DIRECT-vs-RECRUITER default
  // reads the pre-update row's opportunityId inside the transaction.
  applyChannel: ApplyChannel;
  // Next SHORTLISTED job at the same company so the walkthrough state machine
  // can focus it. Null when no more shortlisted at this company (caught up).
  nextJobId: string | null;
};

export async function markJobApplied(
  args: MarkJobAppliedArgs,
): Promise<MarkJobAppliedResult> {
  const appliedAt = args.occurredAt ?? new Date();

  // The APPLIED audit event, the status→APPLIED cache flip, and the per-role
  // company dual-write must commit atomically — a mid-flight Stop abort between
  // them could leave an APPLIED event on a row still reading SHORTLISTED, and
  // nothing re-runs to heal it. logJobEvent owns that atomic core (including
  // the WITHDRAWN-style RETURNING id select). The APPLIED specialization — the
  // channel default — is computed here from the pre-update JobInteraction via
  // computeExtraUpdate; the engagement recompute below is derived/idempotent
  // and stays outside.
  //
  // Drafts are NOT touched at APPLIED. The reuse switch means "ok to reuse this
  // later", not "keep this" — keying deletion off it would destroy a letter the
  // user wrote and then marked not-reusable, so nothing is deleted here.
  let channel: ApplyChannel = args.applyChannel ?? ApplyChannel.DIRECT;
  const res = await logJobEvent({
    userId: args.userId,
    item: {
      jobId: args.jobId,
      type: JobEventType.APPLIED,
      occurredAt: appliedAt,
      notes: args.notes,
      jobInteractionUpdate: { status: JobInteractionStatus.APPLIED },
      computeExtraUpdate: (jobInteraction) => {
        channel =
          args.applyChannel ??
          (jobInteraction.opportunityId
            ? ApplyChannel.RECRUITER
            : ApplyChannel.DIRECT);
        return { applyChannel: channel };
      },
    },
  });

  // Recompute the company's auto-derived engagement status. No-op while the
  // company is manually held (APPLYING mid-walkthrough / PAUSED / …); the effect
  // shows for a historical apply logged at an already-CAUGHT_UP company
  // (→ IN_FLIGHT). The walkthrough wrap forces the tail on APPLYING exit.
  if (res.companyId) {
    await refreshCompanyEngagement(args.userId, res.companyId);
  }

  let nextJobId: string | null = null;
  if (res.companyId) {
    const next = await prisma.jobInteraction.findFirst({
      where: {
        userId: args.userId,
        status: JobInteractionStatus.SHORTLISTED,
        job: { companyId: res.companyId },
      },
      orderBy: { updatedAt: "asc" },
      select: { jobId: true },
    });
    nextJobId = next?.jobId ?? null;
  }

  // Focus is ephemeral — no slot / markers to clear. APPLIED is record-only; the
  // user navigates to the next role explicitly (a picker / company_walkthrough).
  return {
    jobId: args.jobId,
    jobTitle: res.jobTitle,
    companyId: res.companyId,
    appliedAt,
    applyChannel: channel,
    nextJobId,
  };
}
