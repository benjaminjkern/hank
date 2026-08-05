import { runUserMessage } from "@/server/agent/runtime/runUserMessage";
import { prisma } from "@/server/db/prisma";

import { TEST_SESSION_ID, USER_ID } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "hank-handles-cross-mode-crud",
  cost: "expensive",
  describe:
    "When the user drops a recruiter pitch mid-conversation, Hank must capture it with create_opportunity instead of dead-ending with 'I can't.' Originally the regression test for putting the additive CRUD set in every mode's tool list; there are no modes or per-flow tool filters left, so it now guards the weaker-but-still-real failure of Hank narrating a capture he never performed. Asserts: create_opportunity tool fired AND a new Opportunity row was created for USER_ID.",
  async run() {
    const notes: string[] = [];
    // Snapshot existing opportunity IDs so we can identify + clean up any new
    // ones the scenario creates.
    const beforeOppIds = new Set(
      (
        await prisma.opportunity.findMany({
          where: { userId: USER_ID },
          select: { id: true },
        })
      ).map((o) => o.id),
    );
    try {
      const toolNames: string[] = [];
      for await (const ev of runUserMessage({
        userId: USER_ID,
        userMessage:
          "Quick aside before we keep going: a recruiter named McKenley Talent just reached out about a Senior Engineer role at Stripe — said base is around $250k. Can you note that down before we continue with the profile?",
        attachmentIds: [],
        sessionIdOverride: TEST_SESSION_ID,
      })) {
        if (ev.type === "tool_use_start") toolNames.push(ev.name);
      }
      const sawCreateOpportunity = toolNames.includes("create_opportunity");
      const newOpps = await prisma.opportunity.findMany({
        where: { userId: USER_ID, id: { notIn: Array.from(beforeOppIds) } },
        select: { id: true, label: true, status: true },
      });
      notes.push(
        `tools fired: ${toolNames.length > 0 ? toolNames.join(", ") : "(none)"}`,
        `create_opportunity fired: ${sawCreateOpportunity}`,
        `new Opportunity rows: ${newOpps.length} (${newOpps
          .map((o) => `"${o.label}" (${o.status})`)
          .join(", ")})`,
      );
      return { ok: sawCreateOpportunity && newOpps.length > 0, notes };
    } finally {
      // Clean up: drop any newly-created opportunities; clear scenario chat;
      // restore session state.
      const after = await prisma.opportunity.findMany({
        where: { userId: USER_ID },
        select: { id: true },
      });
      const newIds = after
        .map((o) => o.id)
        .filter((id) => !beforeOppIds.has(id));
      if (newIds.length > 0) {
        // OpportunityEvent FK is ON DELETE RESTRICT — clear events first.
        await prisma.opportunityEvent.deleteMany({
          where: { opportunityId: { in: newIds } },
        });
        await prisma.opportunity.deleteMany({
          where: { id: { in: newIds } },
        });
      }
      await prisma.chatMessage.deleteMany({
        where: { sessionId: TEST_SESSION_ID },
      });
    }
  },
};

export default scenario;
