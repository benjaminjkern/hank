import { z } from "zod";

import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { switchToCompany } from "@/server/entities/companies/resumeCompany";
import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";
import { buildShowEvents } from "@/server/views/showEvents";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// company_walkthrough — hand the baton to the deterministic layer for one
// company. Takes a slug and an optional steer: it does NOT search. If the slug
// doesn't resolve it fails; use find_companies / list_companies first.
//
// This tool emits no widget. A set-aside company still has to be revived before
// it can be walked, but that question is now asked by the company arm itself
// (rung 0), so the same prompt appears however the arm is entered — this tool, a
// picker pick, or a later re-entry. All the tool does is resolve the slug, mark
// the company as being worked when that's legal, and hand over the target.
//
// It is also the ONLY shortlist entry. Shortlisting is a rung of the company
// ladder, so re-entering the company reaches it once the earlier rungs no-op —
// the same reason there is no separate next-role tool. The one thing plain
// re-entry couldn't express is "redo it, but differently," which is what
// `direction` is for.
// switchToCompany returns a code; the sentence is the tool's because it's
// Hank-facing. The BLOCKED case is phrased as an instruction, not a fact — it's
// the one refusal Hank can act on.
const SWITCH_REFUSALS: Record<
  "not_watchlisted" | "closed" | "unreadable_board",
  string
> = {
  not_watchlisted: "company not in your watchlist",
  closed: "company was previously closed",
  unreadable_board:
    "company's board couldn't be read; needs a revive to re-check",
};

export const companyWalkthroughTool: ToolDef<{
  company: string;
  direction?: string;
}> = {
  name: "company_walkthrough",
  affectsViewedState: true,
  handoff: true,
  description:
    'Start (or resume) a walkthrough on a specific company. Pass `company` (its slug, from list_companies / the watchlist block). Hands off to the deterministic layer, which surfaces that company\'s roles — reading its board and shortlisting first if that hasn\'t happened yet. Use when the user names a specific company ("let\'s do Mistral", "pull up Stripe", "go back to Airbnb") — resolve its slug first (from the watchlist block / list_companies). This tool does NOT search by name: if you don\'t have a slug, use list_companies (or find_companies for a new one). It also covers companies that were set aside earlier: just call it as normal and the user gets asked whether to bring the company back — you never need a separate un-skip step. This is ALSO how you bring up the roles remaining at a company the user is already working ("what else is open there?", "show me the other roles"): call it on that company and the role list comes up. **And it is how you shortlist or re-shortlist** — "which of these should I go for?", "rerun the shortlist", "I updated my thesis, redo this": call it on that company, adding `direction` if the user said what to change. The picks come from a sub-agent that weighs every read role against what you know the user wants — you do NOT choose or type them out. Acknowledge in your text reply BEFORE calling — don\'t act silently.',
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description:
          "Company slug, as shown in list_companies / the watchlist block.",
      },
      direction: {
        type: "string",
        description:
          "Optional steer for the role picks this round, in the user's own terms ('infra roles only', 'I really need remote'). Passing it forces a FRESH round: prior picks are re-ranked on these terms instead of the user being asked whether to keep them. Omit to resume where the company left off — with no direction, an already-decided shortlist is left alone and its roles come straight up.",
      },
    },
    required: ["company"],
  },
  parser: z.object({
    company: z.string(),
    direction: z.string().optional(),
  }),
  async handle(input, ctx) {
    const r = await resolveCompanyBySlug(ctx.userId, input.company);
    if (!r.ok) {
      return slugLookupError(r, { source: "company_walkthrough" });
    }
    const companyId = r.value.id;
    // switchToCompany refuses a CLOSED / BLOCKED company on purpose — walking one
    // means reviving it, and that's the user's call. Skip the status bump for
    // those and hand off anyway; the company arm's rung 0 re-reads the status and
    // asks. (The read here is only to avoid a refusal we already expect, not a
    // second copy of the revive rule — the arm owns that.)
    const ci = await prisma.companyInteraction.findUnique({
      where: { userId_companyId: { userId: ctx.userId, companyId } },
      select: { status: true },
    });
    const setAside =
      ci?.status === CompanyStatus.CLOSED ||
      ci?.status === CompanyStatus.BLOCKED;

    if (setAside) {
      return {
        content: `${r.value.name} was set aside earlier — handing off; the user will be asked whether to bring it back. Nothing more to do this turn.`,
        entryTarget: {
          kind: "company",
          id: companyId,
          direction: input.direction,
        },
      };
    }

    const switched = await switchToCompany({ userId: ctx.userId, companyId });
    if (!switched.ok) {
      return toolError(
        "GATE_BLOCKED",
        `Can't switch: ${SWITCH_REFUSALS[switched.reason]}.`,
        "company_walkthrough:gate:switch_blocked",
      );
    }
    // The panel move is the tool's, not the write's — switchToCompany only sets
    // status. Focus is ephemeral; the entryTarget below is what the state
    // machine actually runs on.
    const { events } = await buildShowEvents(ctx.userId, { companyId });
    return {
      content: `Handed off to the walkthrough on this company. Nothing more to do this turn — it streams its own progress; don't restate the steps or list roles.`,
      events,
      // The entity the state machine runs its arm on, plus the optional steer
      // for its shortlist rung.
      entryTarget: {
        kind: "company",
        id: companyId,
        direction: input.direction,
      },
    };
  },
};
