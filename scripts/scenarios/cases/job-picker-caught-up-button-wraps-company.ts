import { CompanyStatus, JobInteractionStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { runWalkthrough } from "@/server/procedures/registry/walkthrough";

import { SESSION_ID, USER_ID, withFocus, withEventCleanup } from "../lib";

import type { Scenario } from "../lib";

const MID_FLIGHT = [
  JobInteractionStatus.NEW,
  JobInteractionStatus.SCANNED,
  JobInteractionStatus.SHORTLISTED,
  JobInteractionStatus.DEFERRED,
];

const scenario: Scenario = {
  name: "job-picker-caught-up-button-wraps-company",
  cost: "cheap",
  describe:
    "Submitting a next_job_picker caught_up marker MUST call caughtUpCompany (CompanyInteraction.status → CAUGHT_UP). Fixture: pick a non-CAUGHT_UP CompanyInteraction with ≥1 Job rows, temporarily SKIP every mid-flight JobInteraction (so the caughtUpCompany helper's downstream consumers don't trip over open business), send the caught_up marker, assert status flip, then restore.",
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
      `target company: ${ci.company.name} (${ci.companyId})`,
      `original CI status: ${ci.status}`,
    );

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
        const userMessage = `<!--widget-response:${JSON.stringify({
          kind: "next_job_picker",
          companyId: ci.companyId,
          choice: "caught_up",
        })}-->\n[Done with this company]`;
        const result = await withFocus(
          {
            focusedCompanyId: ci.companyId,
            focusedJobId: null,
            focusedOpportunityId: null,
          },
          async () => {
            const gen = runWalkthrough({
              userId: USER_ID,
              sessionId: SESSION_ID,
              userMessage,
            });
            let wrappedUp = false;
            while (true) {
              const next = await gen.next();
              if (next.done) {
                wrappedUp = next.value.wrappedUp;
                break;
              }
            }
            const post = await prisma.companyInteraction.findUnique({
              where: {
                userId_companyId: {
                  userId: USER_ID,
                  companyId: ci.companyId,
                },
              },
              select: { status: true },
            });
            return { wrappedUp, status: post?.status };
          },
        );
        const isCaughtUp = result.status === CompanyStatus.CAUGHT_UP;
        notes.push(
          `post CI status: ${result.status} (expected CAUGHT_UP)`,
          `wrappedUp: ${result.wrappedUp} (expected true)`,
        );
        return { ok: isCaughtUp && result.wrappedUp, notes };
      });
    } finally {
      await prisma.companyInteraction.update({
        where: {
          userId_companyId: { userId: USER_ID, companyId: ci.companyId },
        },
        data: { status: ci.status },
      });
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
