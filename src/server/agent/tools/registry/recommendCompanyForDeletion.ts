import { z } from "zod";

import { recommendCompanyForDeletion } from "@/server/entities/companies/recommendCompanyForDeletion";

import { resolveCompanyArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const recommendCompanyForDeletionTool: ToolDef<{
  company?: string;
  reason: string;
}> = {
  name: "recommend_company_for_deletion",
  // A flag on a global row — the company keeps rendering normally for everyone
  // until an admin reviews it, so nothing the user is looking at changes.
  affectsViewedState: false,
  description:
    "Flag a company for an admin to hard-delete (takes its postings + everyone's tracking with it). Sets a deletion recommendation + reason; the company stays in place and renders normally until an admin reviews it and either approves the delete or clears the flag. This never deletes data itself, and it flags the GLOBAL company for everyone — so reach for the softer options first: close_company keeps the history; untrack_company removes only this user's copy. Only flag when the company itself is junk (added by mistake, a duplicate of another company already on file, a careers URL that turned out to be wrong). Re-calling with a new reason updates the recommendation. `company` is the company's slug — pass the one the user means.",
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description:
          "The company's slug (e.g. 'stripe') — the company the user means.",
      },
      reason: {
        type: "string",
        description:
          "One-sentence justification (e.g. 'duplicate of the anthropic slug'). Shown to the admin reviewing the flag.",
      },
    },
    required: ["reason"],
  },
  parser: z.object({
    company: z.string().optional(),
    reason: z.string().min(1),
  }),
  async handle({ company, reason }, ctx) {
    const resolved = await resolveCompanyArg(ctx, company, {
      source: "recommend_company_for_deletion",
      ambiguousMessage:
        "no company slug passed — pass the slug of the company to flag.",
    });
    if (!resolved.ok) return resolved.result;
    const flagged = await recommendCompanyForDeletion({
      companyId: resolved.id,
      reason,
    });
    if (!flagged) {
      return toolError(
        "ENTITY_NOT_FOUND",
        "no company found to flag for that slug.",
        "recommend_company_for_deletion:not_found:company",
      );
    }
    const prefix = flagged.wasAlreadyFlagged
      ? "Updated the deletion recommendation for"
      : "Flagged for deletion:";
    return {
      content: `${prefix} ${flagged.name}. Reason: ${reason}. An admin will review it — nothing's deleted yet.`,
    };
  },
};
