import { z } from "zod";

import type { CompanyCloseReason } from "@/generated/prisma/client";
import { COMPANY_CLOSE_REASONS } from "@/server/entities/companies/companyInteractionInputs";
import { closeCompany } from "@/server/entities/companies/setCompanyAside";

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
    "Close a company out — mark it a genuine dead-end that won't work anytime soon (off-thesis company/domain, or a location the user can never take). Bulk-closes its remaining non-terminal jobs, wraps the company up, and brings what's next up on its own — don't call show_whats_next after it. Use when the user has decided to pass on a whole company for good. **Do NOT close for 'nothing fits right now' — if the company is on-thesis and could plausibly post a fit later, use caught_up_company instead. Do NOT close for 'couldn't read the board' — use block_company.** **company is optional — if omitted, defaults to the currently-focused company.** Don't ask the user to confirm which one when 'this' clearly means the focus. **This also works on an ALREADY-closed company — re-call it to change the close reason/note; you do NOT need to revive the company first.** To fix a company's stored status or reason without it being a fresh decision, use update_company_interaction. Say \"close\" / \"pass on\" to the user, never \"skip\".",
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description:
          "The company's slug — the company the user means by 'this'.",
      },
      reason: {
        type: "string",
        enum: COMPANY_CLOSE_REASONS as readonly string[] as string[],
      },
      note: {
        type: "string",
        description:
          "The user's actual reason, in their own words where possible — one sentence. Fill this whenever you have it (ask the user a short 'why?' first if they didn't say and it isn't clear from context). The enum reason buckets the skip; this note is what's read back later.",
      },
    },
    required: ["reason"],
  },
  parser: z.object({
    company: z.string().optional(),
    reason: z.enum(COMPANY_CLOSE_REASONS),
    note: z.string().optional(),
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
    // `endedCompanyId` is what runs the segment wrap (consolidate + compact),
    // once per message in the chat runner. Closing ENDS the company wherever it
    // was fired from, so every close reports it.
    return {
      content: `Closed (${input.reason}). Wrapped up this company — what's next comes up on its own after your reply, so don't ask what they want to do next.`,
      endedCompanyId: companyId,
    };
  },
};
