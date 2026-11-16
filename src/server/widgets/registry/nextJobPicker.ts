// The company walkthrough's role picker. Two answers:
//   - "pick": work the chosen role. A DEFERRED pick revives to SHORTLISTED in
//     the same write — "I want to look at this now" puts the role back in play,
//     matching the company-side pause revive. Typed equivalent: work_on_job,
//     which calls the same promoteJobForWork.
//   - "caught_up": land the company's engagement tail (IN_FLIGHT / IN_PROCESS
//     if applications went out this round, else CAUGHT_UP), then the chooser.
//     Typed equivalent: caught_up_company.

import { sayUiEvents, statusEvent } from "@/server/contracts";
import type { Say, StepOutcome } from "@/server/contracts";
import { prisma } from "@/server/db/prisma";
import { caughtUpCompany } from "@/server/entities/companies/setCompanyAside";
import { promoteJobForWork } from "@/server/entities/jobs/setJobAside";
import { narrateCompanyCaughtUp } from "@/server/procedures/registry/companyWalkthrough/narration";
import { sayStateChange } from "@/server/procedures/registry/companyWalkthrough/sayStateChange";
import { buildShowEvents } from "@/server/views/showEvents";
import { formatFocusRefToken } from "@/shared/focusRefToken";

import { parseWidgetSubmission } from "../parse";

import type { WidgetAnswerDef } from "./types";

type NextJobPickerAnswer = { kind: "next_job_picker"; companyId: string } & (
  { choice: "pick"; jobId: string } | { choice: "caught_up" }
);

export const nextJobPickerAnswer: WidgetAnswerDef<NextJobPickerAnswer> = {
  parse: (message) => {
    const s = parseWidgetSubmission(message);
    return s?.kind === "next_job_picker" ? s : null;
  },
  answer: async (submission, args): Promise<StepOutcome> => {
    if (submission.choice === "caught_up") {
      const { status } = await caughtUpCompany({
        userId: args.userId,
        companyId: submission.companyId,
        derive: true,
      });
      const company = await prisma.company.findUnique({
        where: { id: submission.companyId },
        select: { name: true },
      });
      await sayStateChange(
        args.say,
        narrateCompanyCaughtUp({
          companyId: submission.companyId,
          companyName: company?.name ?? null,
          status,
        }),
        (await buildShowEvents(args.userId)).events,
      );
      return { next: { kind: "show_whats_next" }, ended: "company" };
    }

    const ji = await prisma.jobInteraction.findFirst({
      where: { userId: args.userId, jobId: submission.jobId },
      select: { status: true },
    });
    // Stale click — the role is gone (admin-deleted, or the widget outlived a
    // status change). Re-render the chooser against current data.
    if (!ji) return { next: { kind: "show_whats_next" } };

    await promoteJobForWork({ userId: args.userId, jobId: submission.jobId });
    await sayUiEvents(
      args.say,
      (await buildShowEvents(args.userId, { jobId: submission.jobId })).events,
    );
    await narrateJobFocus(args.say, submission.jobId);
    return {
      next: { kind: "work_on_job", jobId: submission.jobId, freshEntry: true },
    };
  },
};

// "Working on <title>" before drafting starts, so the user sees where they went
// instead of the screen silently jumping into draft mode.
async function narrateJobFocus(say: Say, jobId: string): Promise<void> {
  const j = await prisma.job.findUnique({
    where: { id: jobId },
    select: { title: true },
  });
  const label = j?.title
    ? formatFocusRefToken("job", jobId, j.title)
    : "the next shortlisted job";
  await say(statusEvent(`Working on ${label}.`));
}
