import { JobInteractionStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { USER_ID, drainStateMachine, withFocus } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "job-picker-fires-with-shortlisted-and-deferred",
  cost: "cheap",
  describe:
    "When entering a company arm with at least one SHORTLISTED + one DEFERRED job, the state machine MUST emit a next_job_picker widget (replacing the legacy auto-focus onto stalest SHORTLISTED). Fixture: pick a company with ≥2 SHORTLISTED jobs, temporarily flip one to DEFERRED for the duration of the run, assert the widget fires, then restore.",
  async run() {
    const notes: string[] = [];
    // Find a company (via Job.companyId) that has ≥2 SHORTLISTED
    // JobInteractions for this user. Group rows in app-code since Prisma's
    // groupBy + having on a relation is awkward.
    const shortlistedRows = await prisma.jobInteraction.findMany({
      where: {
        userId: USER_ID,
        status: JobInteractionStatus.SHORTLISTED,
      },
      select: { jobId: true, job: { select: { companyId: true } } },
      take: 200,
    });
    const byCompany = new Map<string, string[]>();
    for (const row of shortlistedRows) {
      const cid = row.job.companyId;
      if (!cid) continue;
      const list = byCompany.get(cid) ?? [];
      list.push(row.jobId);
      byCompany.set(cid, list);
    }
    const targetCompanyId = [...byCompany.entries()].find(
      ([, jobs]) => jobs.length >= 2,
    )?.[0];
    if (!targetCompanyId) {
      return {
        ok: true,
        notes,
        skipped: "no company with ≥2 SHORTLISTED jobs to split",
      };
    }
    const [keepShortlistedJobId, flipToDeferredJobId] = byCompany
      .get(targetCompanyId)!
      .slice(0, 2);
    const orig = await prisma.jobInteraction.findUniqueOrThrow({
      where: {
        userId_jobId: { userId: USER_ID, jobId: flipToDeferredJobId },
      },
      select: {
        status: true,
        deferReason: true,
        deferNote: true,
      },
    });
    await prisma.jobInteraction.update({
      where: {
        userId_jobId: { userId: USER_ID, jobId: flipToDeferredJobId },
      },
      data: {
        status: JobInteractionStatus.DEFERRED,
        deferReason: "OTHER",
        deferNote: "scenario fixture",
      },
    });
    try {
      const result = await withFocus(
        {
          focusedCompanyId: targetCompanyId,
          focusedJobId: null,
          focusedOpportunityId: null,
        },
        async () => await drainStateMachine(),
      );
      const widget = result.events.find(
        (e) => e.type === "pipeline_widget" && e.kind === "next_job_picker",
      );
      notes.push(
        `widget fired: ${!!widget}`,
        `wrappedUp: ${result.wrappedUp} (expected false; widget is interactive)`,
        `keep SHORTLISTED jobId: ${keepShortlistedJobId}`,
        `flipped→DEFERRED jobId: ${flipToDeferredJobId}`,
      );
      return {
        ok: !!widget && !result.wrappedUp,
        notes,
      };
    } finally {
      await prisma.jobInteraction.update({
        where: {
          userId_jobId: { userId: USER_ID, jobId: flipToDeferredJobId },
        },
        data: {
          status: orig.status,
          deferReason: orig.deferReason,
          deferNote: orig.deferNote,
        },
      });
    }
  },
};

export default scenario;
