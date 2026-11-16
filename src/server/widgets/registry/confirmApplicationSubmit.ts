// "I submitted ✓" on a drafted application. Records the application, then hands
// back to the company walkthrough as a continuation — it surfaces the next role
// (or settles the company) and never starts new work there. It does NOT continue
// straight to the next role: between roles is the user's pick, not the loop's.
// Typed equivalent: mark_job_applied.

import { sayUiEvents, statusEvent } from "@/server/contracts";
import type { StepOutcome } from "@/server/contracts";
import { prisma } from "@/server/db/prisma";
import { runCommitApplication } from "@/server/procedures/registry/commitApplication";
import { narrateJobApplied } from "@/server/procedures/registry/companyWalkthrough/narration";
import { buildShowEvents } from "@/server/views/showEvents";

import { parseWidgetSubmission } from "../parse";

import type { WidgetAnswerDef } from "./types";

type SubmitAnswer = { kind: "confirm_application_submit"; jobId: string };

export const confirmApplicationSubmitAnswer: WidgetAnswerDef<SubmitAnswer> = {
  parse: (message) => {
    const s = parseWidgetSubmission(message);
    return s?.kind === "confirm_application_submit" ? s : null;
  },
  answer: async (submission, args): Promise<StepOutcome> => {
    const result = await runCommitApplication({
      ...args,
      jobId: submission.jobId,
    });
    await args.say(
      statusEvent(
        narrateJobApplied({
          jobTitle: result.jobTitle,
          applyChannel: result.applyChannel,
        }),
      ),
    );
    const job = await prisma.job.findUnique({
      where: { id: submission.jobId },
      select: { companyId: true },
    });
    if (!job?.companyId) return { next: { kind: "show_whats_next" } };
    await sayUiEvents(
      args.say,
      (await buildShowEvents(args.userId, { companyId: job.companyId })).events,
    );
    return {
      next: {
        kind: "company_walkthrough",
        companyId: job.companyId,
        continuation: true,
      },
    };
  },
};
