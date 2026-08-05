import { JobInteractionStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { USER_ID, drainPipeline, withFocus } from "../lib";

import type { Scenario } from "../lib";

const scenario: Scenario = {
  name: "agent-text-reply-no-duplicate-terminal",
  cost: "cheap",
  describe:
    "Free-text agent reply (no tool call) on a SHORTLISTED-with-drafts focused job should leave the chat with the agent's text but NO 'Draft ready' duplicate from the state machine. State machine still runs (it's idempotent) but didWork=false suppresses the terminal text.",
  async run() {
    const notes: string[] = [];
    // Need a SHORTLISTED-with-drafts job to focus on, so state machine has
    // nothing to advance to.
    const candidate = await prisma.jobInteraction.findFirst({
      where: {
        userId: USER_ID,
        status: JobInteractionStatus.SHORTLISTED,
        coverLetter: { not: null },
        shortAnswers: { not: Prisma.JsonNull },
      },
      select: { jobId: true },
    });
    if (!candidate) {
      return {
        ok: true,
        notes,
        skipped: "no SHORTLISTED+drafts job to focus on",
      };
    }
    return await withFocus(
      {
        focusedCompanyId: null,
        focusedJobId: candidate.jobId,
        focusedOpportunityId: null,
      },
      async () => {
        const r = await drainPipeline(
          "Hypothetically, can you remind me what cover letter you drafted is about? Just answer in chat.",
        );
        const draftReadyCount = r.events.filter(
          (e) => e.type === "text" && e.text?.includes("Draft ready"),
        ).length;
        notes.push(
          `action tool calls during turn: ${r.actionToolCalls} (expected 0)`,
          `read tool calls during turn: ${r.toolCalls - r.actionToolCalls} (informational)`,
          `'Draft ready' events: ${draftReadyCount} (expected 0)`,
        );
        return { ok: r.actionToolCalls === 0 && draftReadyCount === 0, notes };
      },
    );
  },
};

export default scenario;
