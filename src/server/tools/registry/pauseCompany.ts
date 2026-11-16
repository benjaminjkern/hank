import { z } from "zod";

import { sayUiEvents } from "@/server/contracts";
import { COMPANY_PAUSE_REASONS } from "@/server/entities/companies/companyInteractionInputs";
import { pauseCompany } from "@/server/entities/companies/setCompanyAside";
import type { CompanyPauseReason } from "@/server/generated/prisma/client";
import { buildShowEvents } from "@/server/panels/showEvents";

import { resolveCompanyArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

export const pauseCompanyTool: ToolDef<{
  company?: string;
  reason: CompanyPauseReason;
  note?: string;
}> = {
  name: "pause_company",
  affectsViewedState: true,
  // NOT handoff — see close_company. Pausing is a mutation; it wraps inline.
  description:
    "Pause a company you've started on — set it aside deliberately for now, with a reason. Use when the user wants to stop working a company they've begun but isn't dropping it ('put this on hold', 'set this aside', 'not right now'). It stays off the scan list until revived — there's NO revisit timer; it waits indefinitely until the user brings it back. NOT the same as caught_up_company (that's 'I worked through everything, keep watching for new roles' and stays scannable). It moves nothing on its own — then hand off to wherever the user said to go next, or call show_whats_next if they didn't. **`company` is the company's slug — pass the one the user means.** Say \"pause\" / \"set aside\" to the user.",
  parser: z.object({
    company: z
      .string()
      .optional()
      .describe("The company's slug — the company the user means."),
    reason: z
      .enum(COMPANY_PAUSE_REASONS)
      .describe(
        "USER_PAUSED when the user asked to set it aside; OTHER otherwise. COMPANY-level values: parking a single role is defer_job, whose reasons are a separate list (OUTRANKED / OTHER) — the two never overlap, so don't cross-use them.",
      ),
    note: z
      .string()
      .optional()
      .describe(
        "The user's actual reason for pausing, in their own words where possible — one sentence. Fill this whenever you have it (ask a short 'why?' first if they didn't say and it isn't clear from context).",
      ),
  }),
  async handle(input, ctx) {
    const resolved = await resolveCompanyArg(ctx, input.company, {
      source: "pause_company",
      ambiguousMessage: "no company slug provided — pass the company's slug",
    });
    if (!resolved.ok) return resolved.result;
    const companyId = resolved.id;
    await pauseCompany({
      userId: ctx.userId,
      companyId,
      reason: input.reason,
      note: input.note,
    });
    // The panel was showing the company that just ended.
    await sayUiEvents(ctx.say, (await buildShowEvents(ctx.userId)).events);
    return {
      content: `Paused (${input.reason}). The panel is back on their dashboard. Nothing moves on its own after this: if the user already said where to go next, hand off to it now (company_walkthrough / work_on_job / find_companies); if they didn't, call show_whats_next to put their options up.`,
      ended: "company",
    };
  },
};
