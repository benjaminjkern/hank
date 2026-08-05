import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { runWhatsNext } from "@/server/procedures/registry/whatsNext";

import { SESSION_ID, USER_ID } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "picker-immediate-contains-active",
  cost: "cheap",
  describe:
    "runWhatsNext should surface every ACTIVE company in the immediate section. SKIP if no ACTIVE companies exist. Verifies the picker correctly reflects mid-flow work the user can resume.",
  async run() {
    const notes: string[] = [];
    const active = await prisma.companyInteraction.findMany({
      where: { userId: USER_ID, status: CompanyStatus.APPLYING },
      select: { companyId: true, company: { select: { name: true } } },
      take: 10,
    });
    if (active.length === 0) {
      return { ok: true, notes, skipped: "no ACTIVE companies" };
    }
    {
      const result = await runWhatsNext({
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
      if (result.kind !== "pick") {
        notes.push(
          `result.kind = ${result.kind} (expected "pick") — profile gate may be open`,
        );
        return { ok: false, notes };
      }
      const immediateCompanyIds = new Set(
        result.options.immediate
          .filter((r) => r.kind === "company")
          .map((r) => r.id),
      );
      const missing = active.filter(
        (a) => !immediateCompanyIds.has(a.companyId),
      );
      notes.push(
        `ACTIVE companies in DB: ${active.length}`,
        `Picker immediate (company kind): ${immediateCompanyIds.size}`,
        `missing from immediate: ${missing.length}`,
      );
      return { ok: missing.length === 0, notes };
    }
  },
};

export default scenario;
