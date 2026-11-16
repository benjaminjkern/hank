import { z } from "zod";

import { sayUiEvents } from "@/server/contracts";
import { COMPANY_CLOSE_REASONS } from "@/server/entities/companies/companyInteractionInputs";
import { closeCompany } from "@/server/entities/companies/setCompanyAside";
import type { CompanyCloseReason } from "@/server/generated/prisma/client";
import { buildShowEvents } from "@/server/views/showEvents";

import { resolveCompanyArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

export const closeCompanyTool: ToolDef<{
  company?: string;
  reason: CompanyCloseReason;
  note?: string;
}> = {
  name: "close_company",
  affectsViewedState: true,
  description:
    "Close a company out — mark it a genuine dead-end that won't work anytime soon (off-thesis company/domain, or a location the user can never take). Bulk-closes its remaining non-terminal jobs. It moves nothing on its own — then hand off to wherever the user said to go next, or call show_whats_next if they didn't. Use when the user has decided to pass on a whole company for good. **Do NOT close for 'nothing fits right now' — if the company is on-thesis and could plausibly post a fit later, use caught_up_company instead. Do NOT close for 'couldn't read the board' — use block_company.** **`company` is the company's slug — pass the one the user means.** Don't ask the user to confirm which one when 'this' clearly means the company you've been discussing. **This also works on an ALREADY-closed company — re-call it to change the close reason/note; you do NOT need to revive the company first.** To fix a company's stored status or reason without it being a fresh decision, use update_company_interaction. Say \"close\" / \"pass on\" to the user, never \"skip\".",
  parser: z.object({
    company: z
      .string()
      .optional()
      .describe("The company's slug — the company the user means by 'this'."),
    reason: z
      .enum(COMPANY_CLOSE_REASONS)
      .describe(
        "Why this whole EMPLOYER is a dead end. NOT_A_MATCH = the company or its domain is off-thesis. LOCATION_MISMATCH = everything they post is somewhere the user can never take. OTHER = anything else (put it in the note). These are COMPANY-level values: the same three names on close_job mean that one role. There is deliberately no USER_REJECTED here — a user passing on a specific role is close_job.",
      ),
    note: z
      .string()
      .optional()
      .describe(
        "The user's actual reason, in their own words where possible — one sentence. Fill this whenever you have it (ask the user a short 'why?' first if they didn't say and it isn't clear from context). The enum reason buckets the skip; this note is what's read back later.",
      ),
  }),
  async handle(input, ctx) {
    const resolved = await resolveCompanyArg(ctx, input.company, {
      source: "close_company",
      ambiguousMessage: "no company slug provided — pass the company's slug",
    });
    if (!resolved.ok) return resolved.result;
    const companyId = resolved.id;
    await closeCompany({
      userId: ctx.userId,
      companyId,
      reason: input.reason,
      note: input.note,
    });
    // `ended` is what files the stretch away (consolidate + compact), once per
    // message in the chat loop. Closing ENDS the company wherever it was fired
    // from, so every close reports it.
    // The panel was showing the company that just ended.
    await sayUiEvents(ctx.say, (await buildShowEvents(ctx.userId)).events);
    return {
      content: `Closed (${input.reason}). The panel is back on their dashboard. Nothing moves on its own after this: if the user already said where to go next, hand off to it now (company_walkthrough / work_on_job / find_companies); if they didn't, call show_whats_next to put their options up.`,
      ended: "company",
    };
  },
};
