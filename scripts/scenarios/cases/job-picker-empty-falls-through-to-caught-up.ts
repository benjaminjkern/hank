import { CompanyStatus, JobInteractionStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import {
  USER_ID,
  drainStateMachine,
  withEventCleanup,
  withFocus,
} from "../lib";

import type { Scenario } from "../lib";

const MID_FLIGHT = [
  JobInteractionStatus.NEW,
  JobInteractionStatus.SCANNED,
  JobInteractionStatus.SHORTLISTED,
  JobInteractionStatus.DEFERRED,
];

const scenario: Scenario = {
  name: "job-picker-empty-falls-through-to-caught-up",
  cost: "cheap",
  describe:
    "When entering a company arm with neither SHORTLISTED nor DEFERRED jobs, the state machine MUST fall through to caughtUpCompany (legacy auto-wrap). No widget renders empty — this is the single auto-CAUGHT_UP path remaining. Fixture: pick any non-CAUGHT_UP CompanyInteraction with ≥1 Job rows, temporarily SKIP every mid-flight JobInteraction so the picker can't fire, drain the state machine, assert no next_job_picker widget AND CAUGHT_UP transition, restore.",
  async run() {
    const notes: string[] = [];
    const candidates = await prisma.companyInteraction.findMany({
      where: {
        userId: USER_ID,
        status: {
          notIn: [
            CompanyStatus.CAUGHT_UP,
            CompanyStatus.CLOSED,
            CompanyStatus.PAUSED,
          ],
        },
      },
      select: {
        companyId: true,
        status: true,
        company: { select: { name: true } },
      },
      take: 50,
    });
    let target: (typeof candidates)[number] | null = null;
    for (const ci of candidates) {
      const totalJobs = await prisma.job.count({
        where: { companyId: ci.companyId },
      });
      if (totalJobs > 0) {
        target = ci;
        break;
      }
    }
    if (!target) {
      return {
        ok: true,
        notes,
        skipped: "no non-CAUGHT_UP CompanyInteraction with ≥1 Job rows",
      };
    }
    const ci = target;
    notes.push(
      `target company: ${ci.company.name}`,
      `original CI status: ${ci.status}`,
    );

    // Snapshot every mid-flight JobInteraction so we can put them back. The
    // scenario flips them all to CLOSED for the duration so step 1/2/2.5
    // each see zero open work and the company arm falls through to
    // caughtUpCompany at step 3 — the only path we care to assert here.
    const midFlightRows = await prisma.jobInteraction.findMany({
      where: {
        userId: USER_ID,
        status: { in: MID_FLIGHT },
        job: { companyId: ci.companyId },
      },
      select: {
        jobId: true,
        status: true,
        closeReason: true,
        closeNote: true,
        deferReason: true,
        deferNote: true,
      },
    });
    await prisma.jobInteraction.updateMany({
      where: {
        userId: USER_ID,
        status: { in: MID_FLIGHT },
        job: { companyId: ci.companyId },
      },
      data: {
        status: JobInteractionStatus.CLOSED,
        closeReason: "OTHER",
        closeNote: "scenario fixture",
        deferReason: null,
        deferNote: null,
      },
    });
    try {
      return await withEventCleanup(async () => {
        const result = await withFocus(
          {
            focusedCompanyId: ci.companyId,
            focusedJobId: null,
            focusedOpportunityId: null,
          },
          async () => await drainStateMachine(),
        );
        const sawPickerWidget = result.events.some(
          (e) => e.type === "pipeline_widget" && e.kind === "next_job_picker",
        );
        const post = await prisma.companyInteraction.findUnique({
          where: {
            userId_companyId: { userId: USER_ID, companyId: ci.companyId },
          },
          select: { status: true },
        });
        const isCaughtUp = post?.status === CompanyStatus.CAUGHT_UP;
        notes.push(
          `next_job_picker widget seen: ${sawPickerWidget} (expected false)`,
          `post CI status: ${post?.status} (expected CAUGHT_UP)`,
          `wrappedUp: ${result.wrappedUp} (expected true)`,
        );
        return {
          ok: !sawPickerWidget && isCaughtUp && result.wrappedUp,
          notes,
        };
      });
    } finally {
      await prisma.companyInteraction.update({
        where: {
          userId_companyId: { userId: USER_ID, companyId: ci.companyId },
        },
        data: { status: ci.status },
      });
      // Restore each JobInteraction's prior shape — `updateMany` was atomic
      // on the flip side; we mirror it on the restore side row-by-row to
      // preserve per-row reason/note state.
      for (const row of midFlightRows) {
        await prisma.jobInteraction.update({
          where: { userId_jobId: { userId: USER_ID, jobId: row.jobId } },
          data: {
            status: row.status,
            closeReason: row.closeReason,
            closeNote: row.closeNote,
            deferReason: row.deferReason,
            deferNote: row.deferNote,
          },
        });
      }
    }
  },
};

export default scenario;
