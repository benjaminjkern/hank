import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { runWhatsNext } from "@/server/procedures/registry/whatsNext";

import { SESSION_ID, USER_ID } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "picker-backlog-contains-ready-and-new",
  cost: "cheap",
  describe:
    "runWhatsNext should surface READY + NEW companies in the backlog section, READY first. SKIP if no READY/NEW companies exist.",
  async run() {
    const notes: string[] = [];
    const backlogDb = await prisma.companyInteraction.findMany({
      where: {
        userId: USER_ID,
        status: { in: [CompanyStatus.READY, CompanyStatus.NEW] },
      },
      select: { companyId: true, status: true },
      take: 50,
    });
    if (backlogDb.length === 0) {
      return { ok: true, notes, skipped: "no READY/NEW companies" };
    }
    {
      const result = await runWhatsNext({
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
      if (result.kind !== "pick") {
        notes.push(`result.kind = ${result.kind} (expected "pick")`);
        return { ok: false, notes };
      }
      const backlogIds = result.options.backlog
        .filter((r) => r.kind === "company")
        .map((r) => r.id);
      const backlogIdSet = new Set(backlogIds);
      const missing = backlogDb.filter((c) => !backlogIdSet.has(c.companyId));
      // Order check: first non-READY index should be >= last READY index.
      const readyIds = new Set(
        backlogDb
          .filter((c) => c.status === CompanyStatus.READY)
          .map((c) => c.companyId),
      );
      let lastReadyIdx = -1;
      let firstNewIdx = -1;
      backlogIds.forEach((id, i) => {
        if (readyIds.has(id)) lastReadyIdx = i;
        else if (firstNewIdx === -1) firstNewIdx = i;
      });
      const orderingOk =
        firstNewIdx === -1 || lastReadyIdx === -1 || lastReadyIdx < firstNewIdx;
      notes.push(
        `READY/NEW in DB: ${backlogDb.length}`,
        `backlog (company kind): ${backlogIds.length}`,
        `missing from backlog: ${missing.length}`,
        `READY-before-NEW ordering ok: ${orderingOk}`,
      );
      return { ok: missing.length === 0 && orderingOk, notes };
    }
  },
};

export default scenario;
