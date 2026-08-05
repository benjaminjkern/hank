import { z } from "zod";

import { ProposedBy, ProposedVerdict } from "@/generated/prisma/client";
import { resolveJobBySlug } from "@/server/entities/resolveBySlug";
import { runReconsiderJob } from "@/server/procedures/registry/reconsiderJob";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

const VERDICT_WORDS = ["pick", "borderline", "pass"] as const;
const VERDICT_FOR: Record<(typeof VERDICT_WORDS)[number], ProposedVerdict> = {
  pick: ProposedVerdict.PICK,
  borderline: ProposedVerdict.BORDERLINE,
  pass: ProposedVerdict.PASS,
};

// update_shortlist_proposal — move ONE role's stance on the shortlist board.
// Negotiation state only: no status changes, no events; commit_shortlist is
// what makes the board real. On a role the pipeline never read, it's also the
// way IN: the posting is read first, then the row joins the board with the
// stance. Roles an earlier pass closed are read-only history here — reopening
// one is a repair (update_job_interaction), not a board move.
export const updateShortlistProposalTool: ToolDef<{
  job: string;
  verdict: (typeof VERDICT_WORDS)[number];
  reason: string;
}> = {
  name: "update_shortlist_proposal",
  description:
    "Move one role's stance on the company's OPEN shortlist board: 'pick' (recommend applying), 'borderline' (in play, undecided), or 'pass' (recommend never applying — the role closes when the board is committed). Use it while discussing the shortlist with the user — when they push back on a stance, or you change your read. It also works on a role that hasn't been read yet ('what about the Denver one?'): the posting gets read and the role joins the board. Roles an earlier pass already closed can't be marked — use update_job_interaction if one genuinely needs reopening. Once a board is committed it's closed: there are no stances left to move, and a later change of mind is close_job / defer_job on that role. Nothing becomes final until commit_shortlist. `job` is the role's slug; `reason` is one short user-facing sentence shown next to the role on the board.",
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "The role's slug." },
      verdict: {
        type: "string",
        enum: VERDICT_WORDS as readonly string[] as string[],
        description:
          "'pick' = recommend applying. 'borderline' = in play, the user decides. 'pass' = recommend against ever applying (closes at commit).",
      },
      reason: {
        type: "string",
        description:
          "One short user-facing sentence for the board row — why this stance. Natural language, no jargon.",
      },
    },
    required: ["job", "verdict", "reason"],
  },
  parser: z.object({
    job: z.string(),
    verdict: z.enum(VERDICT_WORDS),
    reason: z.string(),
  }),
  async handle(input, ctx) {
    const r = await resolveJobBySlug(ctx.userId, input.job);
    if (!r.ok) return slugLookupError(r);
    const result = await runReconsiderJob({
      ...ctx,
      jobId: r.value.id,
      verdict: VERDICT_FOR[input.verdict],
      reason: input.reason.trim() || null,
      by: ProposedBy.HANK,
    });
    if (result.kind === "not_reconsiderable") {
      return toolError(
        "STATE_CONFLICT",
        result.status === null
          ? `no interaction found for "${input.job}"`
          : `"${input.job}" can't be marked on the board from status ${result.status} — roles that were already closed, delisted, or applied to are history there. Use update_job_interaction if one genuinely needs reopening.`,
        "update_shortlist_proposal:state_conflict",
      );
    }
    const extras = [
      ...(result.enriched ? ["read the posting in full first"] : []),
      ...(result.noBody
        ? ["no posting text is on file, so the board shows bare metadata"]
        : []),
    ];
    return {
      content: `Moved ${r.value.slug} to ${input.verdict} on the board${extras.length ? ` (${extras.join("; ")})` : ""}. The board updates on the user's screen; nothing is final until commit_shortlist.`,
    };
  },
};
