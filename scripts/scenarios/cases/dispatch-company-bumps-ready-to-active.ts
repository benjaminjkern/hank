import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { dispatchNextCompanyPicker } from "@/server/widgets/dispatchNextCompanyPicker";

import { SESSION_ID, USER_ID } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "dispatch-company-bumps-ready-to-active",
  cost: "cheap",
  describe:
    "Picking a READY company via the picker submission should set its status to APPLYING and return it as the entryTarget (the in-memory handoff that replaced both the focus slot and currentFlow). Other APPLYING companies stay APPLYING (concurrent APPLYING allowed). Idempotent — restores status after.",
  async run() {
    const notes: string[] = [];
    const target = await prisma.companyInteraction.findFirst({
      where: { userId: USER_ID, status: CompanyStatus.READY },
      select: {
        companyId: true,
        status: true,
        company: { select: { name: true } },
      },
    });
    if (!target) {
      return { ok: true, notes, skipped: "no READY company available" };
    }
    const priorActives = await prisma.companyInteraction.findMany({
      where: { userId: USER_ID, status: CompanyStatus.APPLYING },
      select: { companyId: true },
    });
    try {
      const result = await dispatchNextCompanyPicker({
        userId: USER_ID,
        sessionId: SESSION_ID,
        submission: {
          kind: "next_company_picker",
          choice: "company",
          companyId: target.companyId,
        },
      });
      const post = await prisma.companyInteraction.findUniqueOrThrow({
        where: {
          userId_companyId: { userId: USER_ID, companyId: target.companyId },
        },
        select: { status: true },
      });
      const stillActiveCount = await prisma.companyInteraction.count({
        where: {
          userId: USER_ID,
          status: CompanyStatus.APPLYING,
          companyId: { in: priorActives.map((c) => c.companyId) },
        },
      });
      if (result.kind !== "enter") {
        notes.push(`dispatch returned ${result.kind}, expected a destination`);
        return { ok: false, notes };
      }
      notes.push(
        `target status after dispatch: ${post.status} (expected APPLYING)`,
        `entryTarget: ${JSON.stringify(result.entryTarget)} (expected company ${target.companyId})`,
        `statusText: "${result.statusText}"`,
        `prior APPLYING count preserved: ${stillActiveCount}/${priorActives.length}`,
      );
      const ok =
        post.status === CompanyStatus.APPLYING &&
        result.entryTarget?.kind === "company" &&
        result.entryTarget?.id === target.companyId &&
        stillActiveCount === priorActives.length;
      return { ok, notes };
    } finally {
      // Restore the picked company to READY so the scenario is idempotent.
      await prisma.companyInteraction.update({
        where: {
          userId_companyId: { userId: USER_ID, companyId: target.companyId },
        },
        data: { status: target.status },
      });
    }
  },
};

export default scenario;
