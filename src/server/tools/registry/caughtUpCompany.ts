import { z } from "zod";

import { sayUiEvents } from "@/server/contracts";
import { prisma } from "@/server/db/prisma";
import { caughtUpCompany } from "@/server/entities/companies/setCompanyAside";
import { WORKABLE_STATUSES } from "@/server/entities/jobs/jobInteractionInputs";
import { JobInteractionStatus } from "@/server/generated/prisma/client";
import { buildShowEvents } from "@/server/panels/showEvents";

import { resolveCompanyArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

const OPEN_ROLES_SHOWN = 10;

// "Caught up" is a DISTINCT lever from skip/defer, and Hank needs his own verb
// for it — without one he reaches for pause_company, the nearest reversible
// set-aside, which mis-records the intent. Semantics: "I've seen
// what's on their board, nothing to act on right now, keep them on my list and
// check back for new postings." Unlike defer it carries no revisit timer — it's
// the open-ended "keep watching" state.
//
// It closes nothing, so it never asks first. Roles still open there keep their
// status and come back the next time the user walks this company — but
// what's-next won't surface them in the meantime, so the result names them and
// Hank says so.
export const caughtUpCompanyTool: ToolDef<{ company?: string }> = {
  name: "caught_up_company",
  affectsViewedState: true,
  description:
    "Mark a company as caught-up: the user has seen its current roles and nothing's actionable right now, but it STAYS on their list and you keep watching for new postings. This is NOT skip (not pursuing at all) and NOT defer (no revisit timer) — it's the open-ended 'keep it, check back later' state. Use it when the user says 'mark as caught up' / 'I'm caught up here' / 'nothing for me now, keep watching' / 'done with this one for now but keep it.' It moves nothing on its own — then hand off to wherever the user said to go next, or call show_whats_next if they didn't. **`company` is the company's slug — pass the one the user means.** It closes nothing: roles still open there keep their status, and the result names them so you can tell the user.",
  parser: z.object({
    company: z
      .string()
      .optional()
      .describe("The company's slug — the company the user means."),
  }),
  async handle(input, ctx) {
    const resolved = await resolveCompanyArg(ctx, input.company, {
      source: "caught_up_company",
      ambiguousMessage: "no company slug provided — pass the company's slug",
    });
    if (!resolved.ok) return resolved.result;
    const companyId = resolved.id;
    // Open = roles the user might still act on. DEFERRED roles are a resolved
    // hold, and the NEW backlog is exactly what caught-up is FOR (nothing
    // reviewed fit) — so neither is worth mentioning.
    const [openRoles] = await Promise.all([
      prisma.jobInteraction.findMany({
        where: {
          userId: ctx.userId,
          job: { companyId },
          status: {
            in: [...WORKABLE_STATUSES, JobInteractionStatus.SCANNED],
          },
        },
        select: { job: { select: { title: true, slug: true } } },
        take: OPEN_ROLES_SHOWN + 1,
      }),
      caughtUpCompany({ userId: ctx.userId, companyId }),
    ]);
    // The panel was showing the company that just ended.
    await sayUiEvents(ctx.say, (await buildShowEvents(ctx.userId)).events);
    const open =
      openRoles.length > 0
        ? ` ${openRoles.length > OPEN_ROLES_SHOWN ? `More than ${OPEN_ROLES_SHOWN}` : openRoles.length} role${openRoles.length === 1 ? " is" : "s are"} still open there (${openRoles
            .slice(0, OPEN_ROLES_SHOWN)
            .map((r) => r.job.slug ?? r.job.title)
            .join(
              ", ",
            )}). They keep their status and come back when the user returns to this company, but won't show up in what's next until then — tell the user that, and close_job / defer_job them only if they say to.`
        : "";
    return {
      content: `Marked caught-up — the company stays on the list and the panel is back on their dashboard.${open} Nothing moves on its own after this: if the user already said where to go next, hand off to it now (company_walkthrough / work_on_job / find_companies); if they didn't, call show_whats_next to put their options up.`,
      ended: "company",
    };
  },
};
