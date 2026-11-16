import { z } from "zod";

import { sayUiEvents } from "@/server/contracts";
import { prisma } from "@/server/db/prisma";
import { caughtUpCompany } from "@/server/entities/companies/setCompanyAside";
import { WORKABLE_STATUSES } from "@/server/entities/jobs/jobInteractionInputs";
import { JobInteractionStatus } from "@/server/generated/prisma/client";
import { buildShowEvents } from "@/server/panels/showEvents";

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
    "Mark a company as caught-up: the user has seen its current roles and nothing's actionable right now, but it STAYS on their list and you keep watching for new postings. This is NOT skip (not pursuing at all) and NOT defer (no revisit timer) — it's the open-ended 'keep it, check back later' state. Use it when the user says 'mark as caught up' / 'I'm caught up here' / 'nothing for me now, keep watching' / 'done with this one for now but keep it.' It moves nothing on its own — then hand off to wherever the user said to go next, or call show_whats_next if they didn't. **`company` is the company's slug — pass the one the user means.** If the company still has roles the user hasn't dealt with, the tool will ask you to confirm first; once the user is OK with it, call again with confirmed:true.",
  parser: z.object({
    company: z
      .string()
      .optional()
      .describe("The company's slug — the company the user means."),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        "Pass true only AFTER the user has confirmed they want to mark it caught-up despite still having open roles (the tool told you to ask). Leave unset/false on the first call.",
      ),
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
            in: [...WORKABLE_STATUSES, JobInteractionStatus.SCANNED],
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
    // The panel was showing the company that just ended.
    await sayUiEvents(ctx.say, (await buildShowEvents(ctx.userId)).events);
    return {
      content: `Marked caught-up — the company stays on the list and the panel is back on their dashboard. Nothing moves on its own after this: if the user already said where to go next, hand off to it now (company_walkthrough / work_on_job / find_companies); if they didn't, call show_whats_next to put their options up.`,
      // Only the path that actually set the status reports it. The open-roles
      // bail above returns without this — nothing was mutated, so there's
      // nothing to file away.
      ended: "company",
    };
  },
};
