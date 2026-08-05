import { z } from "zod";

import { JobInteractionStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { caughtUpCompany } from "@/server/entities/companies/setCompanyAside";

import { resolveCompanyArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

// "Caught up" is a DISTINCT lever from skip/defer, and Hank needs his own verb
// for it — without one he reaches for pause_company, the nearest reversible
// set-aside, which mis-records the intent. Semantics: "I've seen
// what's on their board, nothing to act on right now, keep them on my list and
// check back for new postings." Unlike defer it carries no revisit timer — it's
// the open-ended "keep watching" state.
//
// Guardrail (per product decision): if the company still has roles the user
// hasn't acted on (SHORTLISTED = recommended-and-pending, SCANNED = matched but
// not yet shown), marking caught-up would silently strand that open work — so
// the tool does NOT set the status on the first call; it reports the open roles
// and asks Hank to confirm with the user. Hank re-calls with confirmed:true to
// proceed. With no open roles it sets caught-up directly (the common case).
export const caughtUpCompanyTool: ToolDef<{
  company?: string;
  confirmed?: boolean;
}> = {
  name: "caught_up_company",
  affectsViewedState: true,
  description:
    "Mark a company as caught-up: the user has seen its current roles and nothing's actionable right now, but it STAYS on their list and you keep watching for new postings. This is NOT skip (not pursuing at all) and NOT defer (no revisit timer) — it's the open-ended 'keep it, check back later' state. Use it when the user says 'mark as caught up' / 'I'm caught up here' / 'nothing for me now, keep watching' / 'done with this one for now but keep it.' Wraps the company up and brings what's next up on its own — don't call show_whats_next after it. **`company` is the company's slug — pass the one the user means.** If the company still has roles the user hasn't dealt with, the tool will ask you to confirm first; once the user is OK with it, call again with confirmed:true.",
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description: "The company's slug — the company the user means.",
      },
      confirmed: {
        type: "boolean",
        description:
          "Pass true only AFTER the user has confirmed they want to mark it caught-up despite still having open roles (the tool told you to ask). Leave unset/false on the first call.",
      },
    },
  },
  parser: z.object({
    company: z.string().optional(),
    confirmed: z.boolean().optional(),
  }),
  async handle(input, ctx) {
    const resolved = await resolveCompanyArg(ctx, input.company, {
      source: "caught_up_company",
      ambiguousMessage: "no company slug provided — pass the company's slug",
    });
    if (!resolved.ok) return resolved.result;
    const companyId = resolved.id;
    // Open work = roles the user might still want to act on. DEFERRED roles stay
    // and resurface on their own, and the NEW backlog is exactly what caught-up
    // is FOR (nothing reviewed fit) — so neither counts as "open work" here.
    if (!input.confirmed) {
      const openRoles = await prisma.jobInteraction.count({
        where: {
          userId: ctx.userId,
          job: { companyId },
          status: {
            in: [
              JobInteractionStatus.SHORTLISTED,
              JobInteractionStatus.SCANNED,
            ],
          },
        },
      });
      if (openRoles > 0) {
        return {
          content: `This company still has ${openRoles} open role${openRoles === 1 ? "" : "s"} (recommended or matched but not yet applied to or passed on). Marking it caught-up keeps it on the list and keeps watching for new postings, but those open roles won't be surfaced again unless something new comes in. Confirm with the user that's what they want, then call caught_up_company again with confirmed:true. If they'd rather deal with those roles, leave it as-is.`,
        };
      }
    }
    await caughtUpCompany({ userId: ctx.userId, companyId });
    return {
      content: `Marked caught-up — the company stays on the list and the panel cleared. Wrapped up this company — what's next comes up on its own after your reply, so don't ask what they want to do next.`,
      // Only the path that actually set the status wraps. The open-roles bail
      // above returns without this — nothing was mutated, so there's nothing to
      // wrap and what's-next must not fire over the confirmation question.
      endedCompanyId: companyId,
    };
  },
};
