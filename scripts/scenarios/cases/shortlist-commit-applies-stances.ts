import {
  CompanyStatus,
  JobCloseReason,
  JobDeferReason,
  JobInteractionStatus,
  ProposedBy,
  ProposedVerdict,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { commitShortlist } from "@/server/entities/companies/commitShortlist";

import { USER_ID } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "shortlist-commit-applies-stances",
  cost: "cheap",
  describe:
    "commitShortlist: seed PICK/BORDERLINE/PASS stances onto a company's SCANNED jobs, commit, verify SHORTLISTED / DEFERRED+OUTRANKED(deferNote←reason) / CLOSED land, stances clear, and the company bumps to APPLYING. Restores all state in finally. SKIP if no eligible company exists.",
  async run() {
    const notes: string[] = [];
    const scannedRows = await prisma.jobInteraction.findMany({
      where: { userId: USER_ID, status: JobInteractionStatus.SCANNED },
      select: { jobId: true, job: { select: { companyId: true } } },
      take: 50,
    });
    if (scannedRows.length === 0) {
      return { ok: true, notes, skipped: "no SCANNED jobs on the user" };
    }
    const byCompany = new Map<string, string[]>();
    for (const r of scannedRows) {
      const cid = r.job.companyId;
      if (!cid) continue;
      const arr = byCompany.get(cid) ?? [];
      arr.push(r.jobId);
      byCompany.set(cid, arr);
    }
    let chosen: { companyId: string; jobIds: string[] } | null = null;
    for (const [cid, jobIds] of byCompany) {
      if (!chosen || jobIds.length < chosen.jobIds.length) {
        chosen = { companyId: cid, jobIds };
      }
    }
    if (!chosen) {
      return {
        ok: true,
        notes,
        skipped: "scanned rows had no resolvable companyId",
      };
    }
    const companyId = chosen.companyId;
    const allJobIds = chosen.jobIds.slice();
    // Deterministic spread: i%3 == 0 → PICK, 1 → BORDERLINE, 2 → PASS.
    const stanceFor = (i: number) =>
      i % 3 === 0
        ? ProposedVerdict.PICK
        : i % 3 === 1
          ? ProposedVerdict.BORDERLINE
          : ProposedVerdict.PASS;
    const pickIds = allJobIds.filter((_, i) => i % 3 === 0);
    const borderlineIds = allJobIds.filter((_, i) => i % 3 === 1);
    const passIds = allJobIds.filter((_, i) => i % 3 === 2);

    // Snapshot for restore (the commit writes JobEvents too — those are a real
    // audit trail of a real write and get deleted below by createdAt window).
    const beforeJobs = await prisma.jobInteraction.findMany({
      where: { userId: USER_ID, jobId: { in: allJobIds } },
      select: {
        id: true,
        jobId: true,
        status: true,
        closeReason: true,
        closeNote: true,
        deferReason: true,
        deferNote: true,
        proposedVerdict: true,
        proposedReason: true,
        proposedBy: true,
        proposedAt: true,
      },
    });
    const beforeCompany = await prisma.companyInteraction.findUniqueOrThrow({
      where: { userId_companyId: { userId: USER_ID, companyId } },
      select: { status: true },
    });
    const startedAt = new Date();
    try {
      // Seed stances directly (the ranker isn't under test here).
      await prisma.$transaction(
        allJobIds.map((jobId, i) =>
          prisma.jobInteraction.update({
            where: { userId_jobId: { userId: USER_ID, jobId } },
            data: {
              proposedVerdict: stanceFor(i),
              proposedReason: `scenario stance ${i}`,
              proposedBy: ProposedBy.HANK,
              proposedAt: new Date(),
            },
          }),
        ),
      );

      const r = await commitShortlist({ userId: USER_ID, companyId });
      if (!r.ok) {
        notes.push(`commit refused: ${r.code}`);
        return { ok: false, notes };
      }

      const after = await prisma.jobInteraction.findMany({
        where: { userId: USER_ID, jobId: { in: allJobIds } },
        select: {
          jobId: true,
          status: true,
          closeReason: true,
          deferReason: true,
          deferNote: true,
          proposedVerdict: true,
        },
      });
      const byId = new Map(after.map((j) => [j.jobId, j]));
      const picksOk = pickIds.every(
        (id) => byId.get(id)?.status === JobInteractionStatus.SHORTLISTED,
      );
      const borderlineOk = borderlineIds.every((id) => {
        const j = byId.get(id);
        return (
          j?.status === JobInteractionStatus.DEFERRED &&
          j?.deferReason === JobDeferReason.OUTRANKED &&
          (j?.deferNote ?? "").startsWith("scenario stance")
        );
      });
      const passOk = passIds.every((id) => {
        const j = byId.get(id);
        return (
          j?.status === JobInteractionStatus.CLOSED &&
          j?.closeReason === JobCloseReason.NOT_A_MATCH
        );
      });
      const stancesCleared = allJobIds.every(
        (id) => byId.get(id)?.proposedVerdict === null,
      );
      const postCompany = await prisma.companyInteraction.findUniqueOrThrow({
        where: { userId_companyId: { userId: USER_ID, companyId } },
        select: { status: true },
      });
      const companyBumped =
        pickIds.length === 0 ||
        postCompany.status === CompanyStatus.APPLYING ||
        // Already past APPLYING (engagement statuses) — the bump guard leaves it.
        beforeCompany.status === CompanyStatus.APPLYING;
      notes.push(
        `picks → SHORTLISTED: ${picksOk} (${pickIds.length})`,
        `borderline → DEFERRED/OUTRANKED with note: ${borderlineOk} (${borderlineIds.length})`,
        `pass → CLOSED/NOT_A_MATCH: ${passOk} (${passIds.length})`,
        `stances cleared on commit: ${stancesCleared}`,
        `company status post-commit: ${postCompany.status}`,
      );
      return {
        ok:
          picksOk && borderlineOk && passOk && stancesCleared && companyBumped,
        notes,
      };
    } finally {
      // Delete the events this scenario's commit fanned out (job timeline +
      // the SHORTLIST_RAN company row), then restore rows verbatim.
      await prisma.jobEvent.deleteMany({
        where: {
          jobInteractionId: { in: beforeJobs.map((j) => j.id) },
          createdAt: { gte: startedAt },
        },
      });
      await prisma.companyEvent.deleteMany({
        where: {
          userId: USER_ID,
          companyId,
          createdAt: { gte: startedAt },
        },
      });
      await prisma.$transaction(
        beforeJobs.map((j) =>
          prisma.jobInteraction.update({
            where: { userId_jobId: { userId: USER_ID, jobId: j.jobId } },
            data: {
              status: j.status,
              closeReason: j.closeReason,
              closeNote: j.closeNote,
              deferReason: j.deferReason,
              deferNote: j.deferNote,
              proposedVerdict: j.proposedVerdict,
              proposedReason: j.proposedReason,
              proposedBy: j.proposedBy,
              proposedAt: j.proposedAt,
            },
          }),
        ),
      );
      await prisma.companyInteraction.update({
        where: { userId_companyId: { userId: USER_ID, companyId } },
        data: { status: beforeCompany.status },
      });
    }
  },
};

export default scenario;
