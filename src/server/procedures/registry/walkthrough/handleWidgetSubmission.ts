// Widget submissions the walkthrough machine owns. These are deterministic state
// transitions the user clicked, not free-text chat — so each one commits its
// mutation and then continues into whichever arm the click implies.
//
// (The submissions dispatched ABOVE this layer — shortlist_proposal, the two
// shortlist gates, company_checklist, next_company_picker — live in
// widgets/dispatchTopLevelSubmission.ts.)

import { formatFocusRefToken } from "@/lib/focusRefToken";
import { statusEvent, yieldUiEvents } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { reviveCompany } from "@/server/entities/companies/resumeCompany";
import { caughtUpCompany } from "@/server/entities/companies/setCompanyAside";
import { promoteJobForWork } from "@/server/entities/jobs/setJobAside";
import { runCommitApplication } from "@/server/procedures/registry/commitApplication";
import { buildShowEvents } from "@/server/views/showEvents";
import type { parseWidgetSubmission } from "@/server/widgets/parse";

import { runCompanyArm } from "./companyArm";
import { dispatchByEntryTarget } from "./dispatchByEntryTarget";
import { runJobArm } from "./jobArm";
import {
  narrateCompanyCaughtUp,
  narrateCompanyRevive,
  narrateJobApplied,
} from "./narration";
import { yieldStateChange } from "./yieldStateChange";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

export async function* handleWidgetSubmission(
  submission: NonNullable<ReturnType<typeof parseWidgetSubmission>>,
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  if (submission.kind === "confirm_revive_company") {
    if (submission.answer === "yes") {
      // Reactivate the company + focus it, then continue the walkthrough. The
      // company arm's on-entry scrape (forced fresh by reviveCompany) scans
      // only genuinely-NEW postings; closed roles stay closed, so a revive
      // can't resurrect and re-scan a huge closed backlog. The user can reopen
      // a specific role on request.
      const revived = await reviveCompany({
        userId: args.userId,
        companyId: submission.companyId,
      });
      if (!revived.ok) {
        yield {
          type: "text",
          text: "Hmm, I couldn't pull that company back up — let's pick something else to look at.",
        };
        return { wrappedUp: true };
      }
      const company = await prisma.company.findUnique({
        where: { id: submission.companyId },
        select: { name: true },
      });
      const { events } = await buildShowEvents(args.userId, {
        companyId: submission.companyId,
      });
      yield* yieldStateChange(
        narrateCompanyRevive({
          companyId: submission.companyId,
          companyName: company?.name ?? null,
        }),
        events,
      );
      return yield* runCompanyArm(submission.companyId, args);
    }
    // "no" — leave it set aside; bounce back to the next-company picker.
    return { wrappedUp: true };
  }

  if (submission.kind === "next_job_picker") {
    return yield* handleNextJobPicker(submission, args);
  }

  if (submission.kind === "confirm_application_submit") {
    // Submitted! We deliberately do NOT auto-continue to the write's returned
    // `nextJobId` — between jobs is the user's pick, not the runner's. Fall
    // through to the company arm,
    // which fires the next_job_picker (or wraps CAUGHT_UP when the
    // SHORTLISTED + DEFERRED buckets are both empty).
    const result = await runCommitApplication({
      ...args,
      jobId: submission.jobId,
    });
    yield statusEvent(
      narrateJobApplied({
        jobTitle: result.jobTitle,
        applyChannel: result.applyChannel,
      }),
    );
    const job = await prisma.job.findUnique({
      where: { id: submission.jobId },
      select: { companyId: true },
    });
    // Focus is ephemeral — nothing to clear; re-dispatch to the company arm
    // (next-role picker) and show the company page. A continuation: the tail
    // of the application just submitted, never a fresh visit — no re-scrape.
    if (job?.companyId) {
      yield* yieldUiEvents(
        (await buildShowEvents(args.userId, { companyId: job.companyId }))
          .events,
      );
      return yield* runCompanyArm(job.companyId, args, undefined, {
        continuation: true,
      });
    }
    return { wrappedUp: true };
  }

  // Unknown widget kind for this machine — defer to dispatcher.
  return yield* dispatchByEntryTarget(args);
}

// Handle a next_job_picker submission. Two branches:
//   - "pick": enter the job arm on the chosen job. If the chosen
//     job is currently DEFERRED, revive it (status → SHORTLISTED + clear
//     deferReason / deferNote) in the same transaction.
//     This matches the company-side pause-revive that
//     switchToCompany already does — "I want to look at this now" implies
//     the role is back in play.
//   - "caught_up": call caughtUpCompany and wrap, just like the auto-wrap when
//     no SHORTLISTED jobs remain.
async function* handleNextJobPicker(
  submission: { companyId: string } & (
    { choice: "pick"; jobId: string } | { choice: "caught_up" }
  ),
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  if (submission.choice === "caught_up") {
    // Walkthrough wrap: land the right engagement tail (IN_FLIGHT/IN_PROCESS if
    // apps went out this round, else CAUGHT_UP) instead of forcing CAUGHT_UP.
    const { status } = await caughtUpCompany({
      userId: args.userId,
      companyId: submission.companyId,
      derive: true,
    });
    const company = await prisma.company.findUnique({
      where: { id: submission.companyId },
      select: { name: true },
    });
    yield* yieldStateChange(
      narrateCompanyCaughtUp({
        companyId: submission.companyId,
        companyName: company?.name ?? null,
        status,
      }),
    );
    return { wrappedUp: true, endedCompanyId: submission.companyId };
  }

  // choice === "pick"
  const ji = await prisma.jobInteraction.findFirst({
    where: { userId: args.userId, jobId: submission.jobId },
    select: { status: true },
  });
  if (!ji) {
    // Stale widget click — the JobInteraction is gone (admin-deleted, or
    // the widget outlived a status change). Re-derive instead of throwing.
    return yield* dispatchByEntryTarget(args);
  }

  // Work the role (revives a DEFERRED pick to SHORTLISTED in the same
  // transaction). Focus is ephemeral — no slot or marker to touch. Shared
  // verbatim with the work_on_job tool so a prose "let's do the X role" and a
  // widget pick land in exactly the same state.
  await promoteJobForWork({ userId: args.userId, jobId: submission.jobId });

  yield* yieldUiEvents(
    (await buildShowEvents(args.userId, { jobId: submission.jobId })).events,
  );
  yield* narrateJobFocus(submission.jobId);
  return yield* runJobArm(submission.jobId, args, { freshEntry: true });
}

// Narrate the transition into a job arm so the user sees "Working on
// <title>" instead of the machine silently jumping into draft mode. The caller
// buffers + persists this as a `pipeline_status` block alongside the drafting
// status lines that follow.
async function* narrateJobFocus(jobId: string): AsyncGenerator<TurnEvent> {
  const j = await prisma.job.findUnique({
    where: { id: jobId },
    select: { title: true },
  });
  const label = j?.title
    ? formatFocusRefToken("job", jobId, j.title)
    : "the next shortlisted job";
  yield statusEvent(`Working on ${label}.`);
}
