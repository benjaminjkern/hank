import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { runWhatsNext } from "@/server/procedures/registry/whatsNext";

import { SESSION_ID, USER_ID } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "picker-empty-company-subtitle",
  cost: "cheap",
  describe:
    "When a NEW CompanyInteraction has lastScrapedJobsAt=null AND its Company has zero Job rows, the picker subtitle should say 'Needs scraping — let me try' instead of 'Just added'. Uses a stub Company created + torn down for the scenario.",
  async run() {
    const notes: string[] = [];
    // Create a synthetic Company + CompanyInteraction. Use a random slug so
    // reruns don't collide.
    const stubName = `Picker Subtitle Test ${Math.floor(
      (await prisma.company.count()) % 10000,
    )}`;
    const stubSlug = `picker-subtitle-test-${(await prisma.company.count()) % 10000}`;
    const company = await prisma.company.create({
      data: {
        name: stubName,
        slug: stubSlug,
      },
      select: { id: true },
    });
    await prisma.companyInteraction.create({
      data: {
        userId: USER_ID,
        companyId: company.id,
        status: CompanyStatus.NEW,
        lastScrapedJobsAt: null,
      },
    });
    try {
      const result = await runWhatsNext({
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
      if (result.kind !== "pick") {
        notes.push(`result.kind = ${result.kind} (expected "pick")`);
        return { ok: false, notes };
      }
      const row = result.options.backlog.find(
        (r) => r.kind === "company" && r.id === company.id,
      );
      notes.push(`row found: ${!!row}`);
      const subtitleOk =
        row?.kind === "company" &&
        row.subtitle === "Needs scraping — let me try";
      if (row?.kind === "company") {
        notes.push(`subtitle: ${JSON.stringify(row.subtitle)}`);
      }
      return { ok: subtitleOk, notes };
    } finally {
      await prisma.companyInteraction.deleteMany({
        where: { userId: USER_ID, companyId: company.id },
      });
      await prisma.company.delete({ where: { id: company.id } });
    }
  },
};

export default scenario;
