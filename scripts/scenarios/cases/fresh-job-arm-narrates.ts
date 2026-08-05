import { JobInteractionStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { USER_ID, drainStateMachine, withFocus } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "fresh-job-arm-narrates",
  cost: "expensive",
  describe:
    "Brand-new job arm (no drafts yet). State machine should emit 'Working on …' (via the company-arm step 2.5) and the drafting status lines, then 'Draft ready'.",
  async run() {
    const notes: string[] = [];
    // Any SHORTLISTED job that doesn't have a cover letter yet — company-agnostic
    // so it runs against whatever watchlist the scenario user has.
    const candidate = await prisma.jobInteraction.findFirst({
      where: {
        userId: USER_ID,
        status: JobInteractionStatus.SHORTLISTED,
        OR: [{ coverLetter: null }, { coverLetter: "" }],
      },
      select: { jobId: true, job: { select: { companyId: true } } },
    });
    if (!candidate) {
      return {
        ok: true,
        notes,
        skipped: "no SHORTLISTED job without a cover letter",
      };
    }
    // Focus on that job's company so step 2.5 narrates.
    const result = await withFocus(
      {
        focusedCompanyId: candidate.job.companyId,
        focusedJobId: null,
        focusedOpportunityId: null,
      },
      () => drainStateMachine(),
    );
    const statuses = result.events.filter((e) => e.type === "pipeline_status");
    const text = result.events.filter((e) => e.type === "text");
    const sawWorkingOn = statuses.some((s) =>
      s.text?.startsWith("Working on "),
    );
    const sawDraftReady = text.some((t) => t.text?.includes("Draft ready"));
    const sawDraftingCoverLetter = statuses.some(
      (s) => s.text === "Drafting cover letter…",
    );
    notes.push(
      `Working on …: ${sawWorkingOn}`,
      `Drafting cover letter…: ${sawDraftingCoverLetter}`,
      `Draft ready: ${sawDraftReady}`,
    );
    return {
      ok: sawWorkingOn && sawDraftingCoverLetter && sawDraftReady,
      notes,
    };
  },
};

export default scenario;
