import { z } from "zod";

import { untrackCompany } from "@/server/entities/companies/untrackCompany";

import { resolveCompanyArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const untrackCompanyTool: ToolDef<{ company?: string }> = {
  name: "untrack_company",
  // The company + its roles vanish from the user's view. Focus is ephemeral —
  // the tool doesn't touch any session focus slot; the client refetch triggered
  // by this flag re-derives the panel (same posture as close_company /
  // delete_event, which likewise leave focus to the deterministic layer).
  affectsViewedState: true,
  description:
    'Hard-delete this user\'s tracking of a company — removes it from the watchlist AND untracks every role the user had at it (each role\'s history goes too). The underlying company and its postings stay on file, so it can be re-added later and comes back fresh. The company-level parity of untrack_job: for true cleanup when the user wants the whole company gone ("I added this by mistake", "this isn\'t even a real company", "junk from discovery"). For a normal "not interested in this company" — which keeps the history — use close_company instead; that\'s the right tool almost every time. `company` is the company\'s slug — pass the one the user means.',
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description:
          "The company's slug (e.g. 'stripe') — the company the user means.",
      },
    },
    required: [],
  },
  parser: z.object({ company: z.string().optional() }),
  async handle({ company }, ctx) {
    const resolved = await resolveCompanyArg(ctx, company, {
      source: "untrack_company",
      ambiguousMessage:
        "no company slug passed — pass the slug of the company to untrack.",
    });
    if (!resolved.ok) return resolved.result;
    const removed = await untrackCompany({
      userId: ctx.userId,
      companyId: resolved.id,
    });
    if (!removed) {
      return toolError(
        "ENTITY_NOT_FOUND",
        "that company isn't on the user's watchlist, so there's nothing to untrack. Use list_companies to check the slug.",
        "untrack_company:not_found:watchlist_entry",
      );
    }
    const rolesNote =
      removed.jobsUntracked > 0
        ? ` (and ${removed.jobsUntracked} tracked role${removed.jobsUntracked === 1 ? "" : "s"})`
        : "";
    return {
      content: `Untracked ${removed.name}${rolesNote} — removed from the watchlist. It'll come back fresh if re-added later.`,
    };
  },
};
