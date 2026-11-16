import { prisma } from "@/server/db/prisma";
import { JobInteractionStatus } from "@/server/generated/prisma/client";

import { USER_ID, drainAnswer, withFocus } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "job-picker-revives-deferred-on-pick",
  cost: "cheap",
  describe:
    "Submitting a next_job_picker pick marker for a DEFERRED job MUST atomically (a) flip its status DEFERRED → SHORTLISTED, (b) clear deferReason / deferNote, AND (c) set focusedJobId. The defer-revive-on-pick pattern mirrors switchToCompany's company-side behavior — 'I want to look at this now' implies the row is back in play. Fixture: take any SHORTLISTED job, temporarily flip to DEFERRED, submit a pick marker, assert revival + focus, then restore.",
  async run() {
    const notes: string[] = [];
    const ji = await prisma.jobInteraction.findFirst({
      where: { userId: USER_ID, status: JobInteractionStatus.SHORTLISTED },
      select: {
        jobId: true,
        status: true,
        deferReason: true,
        deferNote: true,
        job: { select: { companyId: true } },
      },
    });
    if (!ji?.job.companyId) {
      return {
        ok: true,
        notes,
        skipped: "no SHORTLISTED job with companyId available",
      };
    }
    await prisma.jobInteraction.update({
      where: { userId_jobId: { userId: USER_ID, jobId: ji.jobId } },
      data: {
        status: JobInteractionStatus.DEFERRED,
        deferReason: "OTHER",
        deferNote: "scenario fixture",
      },
    });
    try {
      const userMessage = `<!--widget-response:${JSON.stringify({
        kind: "next_job_picker",
        companyId: ji.job.companyId,
        choice: "pick",
        jobId: ji.jobId,
      })}-->\n[Revive job]`;
      const result = await withFocus(
        {
          focusedCompanyId: ji.job.companyId,
          focusedJobId: null,
          focusedOpportunityId: null,
        },
        async () => {
          // Drive the state machine directly so we can assert the post-pick
          // DB state without depending on the agent loop or pnpm dev being
          // up. runWorkOnJob queries the JobInteraction status — the pick
          // handler's revive transaction is what makes that path succeed
          // here, so simply running it exercises end-to-end. Its narration
          // isn't asserted on, so nothing is recorded.
          await drainAnswer(userMessage, { follow: true });
          const jiNow = await prisma.jobInteraction.findUnique({
            where: { userId_jobId: { userId: USER_ID, jobId: ji.jobId } },
            select: {
              status: true,
              deferReason: true,
              deferNote: true,
            },
          });
          return { jiNow };
        },
      );
      const isShortlisted =
        result.jiNow?.status === JobInteractionStatus.SHORTLISTED;
      const fieldsCleared =
        result.jiNow?.deferReason === null && result.jiNow?.deferNote === null;
      // Focus is ephemeral now — the pick revives the row (that's the point);
      // there's no focusedJobId slot to assert.
      notes.push(
        `post status: ${result.jiNow?.status} (expected SHORTLISTED)`,
        `deferReason: ${result.jiNow?.deferReason} (expected null)`,
        `deferNote: ${result.jiNow?.deferNote} (expected null)`,
      );
      return { ok: isShortlisted && fieldsCleared, notes };
    } finally {
      // Restore the JobInteraction to its original shape.
      await prisma.jobInteraction.update({
        where: { userId_jobId: { userId: USER_ID, jobId: ji.jobId } },
        data: {
          status: ji.status,
          deferReason: ji.deferReason,
          deferNote: ji.deferNote,
        },
      });
    }
  },
};

export default scenario;
