import { JobInteractionStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { USER_ID, drainStateMachine, withFocus } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "idle-job-arm-is-silent",
  cost: "cheap",
  describe:
    "Focused on a SHORTLISTED job with all drafts done. State machine should emit ZERO events — no repeat 'Draft ready', no statuses. Skip-not-fail if no eligible job exists (test data drifts as the user works).",
  async run() {
    const notes: string[] = [];
    // Need a SHORTLISTED job with cover letter AND short answers on file.
    // Anything else either triggers the defensive guard (not SHORTLISTED)
    // or drafts (no cover letter / no answers) — both burn Anthropic.
    const candidate = await prisma.jobInteraction.findFirst({
      where: {
        userId: USER_ID,
        status: JobInteractionStatus.SHORTLISTED,
        coverLetter: { not: null },
        shortAnswers: { not: Prisma.JsonNull },
      },
      select: { jobId: true, coverLetter: true, shortAnswers: true },
    });
    if (
      !candidate?.coverLetter ||
      !Array.isArray(candidate.shortAnswers) ||
      (candidate.shortAnswers as unknown[]).length === 0
    ) {
      return {
        ok: true,
        notes,
        skipped:
          "no SHORTLISTED job with cover letter + non-empty short answers",
      };
    }
    const result = await withFocus(
      {
        focusedCompanyId: null,
        focusedJobId: candidate.jobId,
        focusedOpportunityId: null,
      },
      () => drainStateMachine(),
    );
    const noisy = result.events.filter(
      (e) =>
        e.type === "text" ||
        e.type === "pipeline_status" ||
        e.type === "pipeline_widget",
    );
    notes.push(`emitted: ${noisy.length} user-visible events (expected 0)`);
    const ok = noisy.length === 0 && result.wrappedUp === false;
    if (!ok) {
      notes.push(...noisy.map((e) => `  - ${e.type}: ${e.text ?? e.kind}`));
    }
    return { ok, notes };
  },
};

export default scenario;
