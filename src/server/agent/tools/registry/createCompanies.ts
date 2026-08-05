import { z } from "zod";

import { createCompanyStubs } from "@/server/entities/companies/createCompanyStubs";

import type { ToolDef } from "../lib/types";

// The create_companies input shape (name + optional disambiguating context).
const CreateCompanyItemSchema = z.object({
  name: z.string().min(1),
  context: z.string().optional(),
});
type CreateCompanyItem = z.infer<typeof CreateCompanyItemSchema>;

// Lightweight company creation — just creates Company rows + CompanyInteraction
// (NEW) for the requested names. No URL hunt, no scrape. The full enrichment
// pipeline (URL hunt → first scan → PRE_SCAN) runs later via an explicit
// enrich_companies call. (For "find me some companies" where the user hasn't
// named any, Hank uses find_companies — its checklist picks enrich immediately.)

export const createCompaniesTool: ToolDef<{
  companies: CreateCompanyItem[];
}> = {
  name: "create_companies",
  affectsViewedState: true,
  description:
    "Add one or more companies the user NAMED to their watchlist. Batched — pass an array; one transaction. For each name, creates a Company row (stub, no URL yet) plus a CompanyInteraction at status=NEW. Doesn't run the URL/ATS hunt — call enrich_companies after to look up each careers page, name and logo. Names that already correspond to existing watchlisted companies are skipped silently. `context` is an optional disambiguating hint (e.g. \"the data-infra one, not the marketing platform\") stored for the URL hunter sub-agent. Use this for 'add Stripe and Anthropic to my list' — the user gave NAMES. If they want ideas instead ('find me some companies', 'who else should I track?'), use find_companies.",
  inputSchema: {
    type: "object",
    properties: {
      companies: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                'Canonical company name as the user said it (e.g. "Cognition Labs").',
            },
            context: {
              type: "string",
              description:
                'Optional disambiguating hint stored for the URL hunter (e.g. "the data-infra one, not the marketing platform"). Don\'t dump conversation history.',
            },
          },
          required: ["name"],
        },
      },
    },
    required: ["companies"],
  },
  parser: z.object({
    companies: z.array(CreateCompanyItemSchema).min(1),
  }),
  async handle({ companies }, ctx) {
    const results = await createCompanyStubs(ctx.userId, companies);

    const lines = results.map((r) => {
      if (r.kind === "existed")
        return `- ${r.name} already on the watchlist (status=${r.status}, slug=${r.slug})`;
      if (r.kind === "attached")
        return `- ${r.name} added to watchlist as NEW (re-used existing Company; slug=${r.slug})`;
      return `- ${r.name} created + added to watchlist as NEW (slug=${r.slug})`;
    });
    const fresh = results.filter((r) => r.kind !== "existed").length;
    return {
      content: `added ${fresh} compan${fresh === 1 ? "y" : "ies"} (skipped ${results.length - fresh} already-tracked):\n${lines.join("\n")}\n\nThese are bare stubs — no careers URL yet. Acknowledge in chat what you added. If the user names more, call create_companies again. When they're done adding, call enrich_companies — it looks up each company's careers page, name and logo, then surfaces the picker so they can start a walkthrough. Open roles are pulled in when a company is actually walked, so don't promise role counts yet. (For "find me some companies" where the user hasn't named any, use find_companies instead.)`,
    };
  },
};
