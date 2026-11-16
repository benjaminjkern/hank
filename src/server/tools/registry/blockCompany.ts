import { z } from "zod";

import { sayUiEvents } from "@/server/contracts";
import { COMPANY_BLOCK_REASONS } from "@/server/entities/companies/companyInteractionInputs";
import { blockCompany } from "@/server/entities/companies/setCompanyAside";
import type { CompanyBlockReason } from "@/server/generated/prisma/client";
import { buildShowEvents } from "@/server/views/showEvents";

import { resolveCompanyArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

// Block = a TECHNICAL set-aside: we couldn't read the company's job board, so
// there's nothing to evaluate. Distinct from close (a fit judgment) and from
// caught-up (read the board, nothing fits now). Revivable — a revive re-hunts
// the board, so a company readable later comes back in. Most blocks happen
// automatically in the walkthrough's empty-company prep; this gives Hank an
// explicit lever for the chat case ("their careers page won't load for me").
export const blockCompanyTool: ToolDef<{
  company?: string;
  reason: CompanyBlockReason;
  note?: string;
}> = {
  name: "block_company",
  affectsViewedState: true,
  // NOT handoff — see close_company. Blocking is a mutation; it wraps inline.
  description:
    "Set a company aside because its job board can't be read — NOT a judgment about fit. Use when you genuinely couldn't load/scrape the company's careers page (after trying, incl. a board behind a login/SPA), or it's a sub-brand that hires under a parent. A revive re-checks the board later, so this is recoverable. **`company` is the company's slug — pass the one the user means.** To the user, frame it plainly (\"I couldn't read their careers page, so I've set them aside for now — I can re-check anytime\"); never say \"closed\" (that means a real dead-end) or use internal words. **If the issue is that the name matches multiple companies, do NOT block — ask the user which one they mean and look that one up.**",
  parser: z.object({
    company: z
      .string()
      .optional()
      .describe("The company's slug — the company the user means."),
    reason: z
      .enum(COMPANY_BLOCK_REASONS)
      .describe(
        "CANNOT_SCRAPE = couldn't read the careers page after trying (includes a board behind a login/SPA — note that in the note). NO_OWN_BOARD = a sub-brand that hires under a parent (name the parent in the note so we can track that instead). OTHER = anything else technical. (An ambiguous name is NOT a block reason — ask the user which company they mean instead.)",
      ),
    note: z
      .string()
      .optional()
      .describe(
        "One sentence on what blocked the read (and, for NO_OWN_BOARD, the parent company name). Recommended.",
      ),
  }),
  async handle(input, ctx) {
    const resolved = await resolveCompanyArg(ctx, input.company, {
      source: "block_company",
      ambiguousMessage: "no company slug provided — pass the company's slug",
    });
    if (!resolved.ok) return resolved.result;
    const companyId = resolved.id;
    await blockCompany({
      userId: ctx.userId,
      companyId,
      reason: input.reason,
      note: input.note,
    });
    // The panel was showing the company that just ended.
    await sayUiEvents(ctx.say, (await buildShowEvents(ctx.userId)).events);
    return {
      content: `Set aside (${input.reason}). The panel is back on their dashboard. Nothing moves on its own after this: if the user already said where to go next, hand off to it now (company_walkthrough / work_on_job / find_companies); if they didn't, call show_whats_next to put their options up.`,
      ended: "company",
    };
  },
};
