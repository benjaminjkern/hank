import { z } from "zod";

import type { CompanyPauseReason } from "@/generated/prisma/client";
import { COMPANY_PAUSE_REASONS } from "@/server/entities/companies/companyInteractionInputs";
import { pauseCompany } from "@/server/entities/companies/setCompanyAside";

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
    "Pause a company you've started on — set it aside deliberately for now, with a reason. Use when the user wants to stop working a company they've begun but isn't dropping it ('put this on hold', 'set this aside', 'not right now'). It stays off the scan list until revived — there's NO revisit timer; it waits indefinitely until the user brings it back. NOT the same as caught_up_company (that's 'I worked through everything, keep watching for new roles' and stays scannable). Wraps the company up and brings what's next up on its own — don't call show_whats_next after it. **`company` is the company's slug — pass the one the user means.** Say \"pause\" / \"set aside\" to the user.",
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description: "The company's slug — the company the user means.",
      },
      reason: {
        type: "string",
        enum: COMPANY_PAUSE_REASONS as readonly string[] as string[],
        description:
          "USER_PAUSED when the user asked to set it aside; OTHER otherwise.",
      },
      note: {
        type: "string",
        description:
          "The user's actual reason for pausing, in their own words where possible — one sentence. Fill this whenever you have it (ask a short 'why?' first if they didn't say and it isn't clear from context).",
      },
    },
    required: ["reason"],
  },
  parser: z.object({
    company: z.string().optional(),
    reason: z.enum(COMPANY_PAUSE_REASONS),
    note: z.string().optional(),
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
    return {
      content: `Paused (${input.reason}). Wrapped up this company — what's next comes up on its own after your reply, so don't ask what they want to do next.`,
      endedCompanyId: companyId,
    };
  },
};
