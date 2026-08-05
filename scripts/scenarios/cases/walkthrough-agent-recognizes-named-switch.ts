import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { USER_ID, drainPipeline, withFocus } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "walkthrough-agent-recognizes-named-switch",
  cost: "expensive",
  describe:
    "When the user names a specific company mid-walkthrough ('let's do <name>'), the walkthrough-agent MUST fire its switch_to_company tool — not pick_next_company, not just respond with text. This is the regression test for the no-orchestrator architecture: routing now happens inside the walkthrough-agent, so a missed switch_to_company means the walkthrough-agent's prompt or tool set has drifted.",
  async run() {
    const notes: string[] = [];
    // Need two distinct watchlist companies. The focused one (A) is where we
    // start the walkthrough; the target one (B) is what the user names. Must
    // match loadSwitchable's ordering (lastDiscussedAt ASC NULLS FIRST, take
    // 30) so the target is guaranteed to appear in the agent's switchable
    // list — otherwise the agent legitimately doesn't know about the company
    // and the test fails for the wrong reason.
    const candidates = await prisma.companyInteraction.findMany({
      where: {
        userId: USER_ID,
        status: { notIn: [CompanyStatus.CLOSED] },
      },
      orderBy: { lastDiscussedAt: { sort: "asc", nulls: "first" } },
      select: {
        companyId: true,
        status: true,
        company: { select: { name: true } },
      },
      take: 8,
    });
    if (candidates.length < 2) {
      return {
        ok: true,
        notes,
        skipped: "need ≥2 non-CLOSED watchlist companies",
      };
    }
    const focused = candidates[0];
    const target = candidates[1];
    // Snapshot target's CompanyInteraction status because switch_to_company
    // will bump non-ACTIVE → ACTIVE; restore after.
    const targetOrig = await prisma.companyInteraction.findUniqueOrThrow({
      where: {
        userId_companyId: {
          userId: USER_ID,
          companyId: target.companyId,
        },
      },
      select: {
        status: true,
        closeReason: true,
        closeNote: true,
        pauseReason: true,
        pauseNote: true,
      },
    });
    try {
      const result = await withFocus(
        {
          focusedCompanyId: focused.companyId,
          focusedJobId: null,
          focusedOpportunityId: null,
        },
        () => drainPipeline(`let's switch to ${target.company.name}`),
      );
      const toolNames = result.events
        .filter((e) => e.type === "tool_use_start")
        .map((e) => e.name);
      const sawSwitchToCompany = toolNames.includes("switch_to_company");
      const sawWrongTool = toolNames.some(
        (n) =>
          n === "pick_next_company" ||
          n === "close_company" ||
          n === "defer_company",
      );
      notes.push(
        `focused: ${focused.company.name} (${focused.status})`,
        `target: ${target.company.name} (${target.status})`,
        `tools fired: ${toolNames.filter(Boolean).join(", ") || "(none)"}`,
        `switch_to_company fired: ${sawSwitchToCompany}`,
        `wrong routing tool fired: ${sawWrongTool}`,
      );
      return { ok: sawSwitchToCompany && !sawWrongTool, notes };
    } finally {
      // Restore the target's CompanyInteraction status. switch_to_company
      // may have flipped it READY/NEW/CAUGHT_UP/DEFERRED → ACTIVE.
      await prisma.companyInteraction.update({
        where: {
          userId_companyId: {
            userId: USER_ID,
            companyId: target.companyId,
          },
        },
        data: targetOrig,
      });
    }
  },
};

export default scenario;
