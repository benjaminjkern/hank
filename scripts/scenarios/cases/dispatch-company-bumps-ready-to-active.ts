import { prisma } from "@/server/db/prisma";
import { CompanyStatus } from "@/server/generated/prisma/client";
import { sayTo } from "@/server/contracts";
import { nextCompanyPickerAnswer } from "@/server/widgets/registry/nextCompanyPicker";

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
      const said: string[] = [];
      const result = await nextCompanyPickerAnswer.answer(
        {
          kind: "next_company_picker",
          choice: "company",
          companyId: target.companyId,
        },
        {
          userId: USER_ID,
          sessionId: SESSION_ID,
          say: sayTo((ev) => {
            if (ev.type === "pipeline_status") said.push(ev.text);
          }),
        },
      );
      const next = result?.next;
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
      notes.push(
        `target status after dispatch: ${post.status} (expected APPLYING)`,
        `next: ${JSON.stringify(next)} (expected company ${target.companyId})`,
        `said: ${JSON.stringify(said)}`,
        `prior APPLYING count preserved: ${stillActiveCount}/${priorActives.length}`,
      );
      const ok =
        post.status === CompanyStatus.APPLYING &&
        next?.kind === "company_walkthrough" &&
        next.companyId === target.companyId &&
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
