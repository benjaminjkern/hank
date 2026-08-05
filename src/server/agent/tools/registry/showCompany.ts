import { z } from "zod";

import { formatFocusRefToken } from "@/lib/focusRefToken";
import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";
import { buildShowEvents } from "@/server/views/showEvents";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// show_company — put a company's page on the user's screen + drop a clickable
// chip in chat. PURE DISPLAY: it switches the right panel and emits a
// "Pulled up <chip>" line, but starts no work and changes no state. It's how
// Hank references an entity visibly in free chat — the presentational
// counterpart to company_walkthrough (which actually walks the roles). Non-
// handoff (Hank keeps talking); the chip is view-only (click re-opens the page).
export const showCompanyTool: ToolDef<{ company: string }> = {
  name: "show_company",
  affectsViewedState: false,
  description:
    "Put a company's page on the user's screen (right panel) and drop a clickable chip in the chat — a pure display action that starts no work and changes nothing. Use it when you're referring to a company and want the user to see it ('here's what I have on Stripe'). NOT for walking its roles — that's company_walkthrough. `company` is the company's slug.",
  inputSchema: {
    type: "object",
    properties: {
      company: { type: "string", description: "The company's slug." },
    },
    required: ["company"],
  },
  parser: z.object({ company: z.string() }),
  async handle(input, ctx) {
    const r = await resolveCompanyBySlug(ctx.userId, input.company);
    if (!r.ok) return slugLookupError(r);
    const show = await buildShowEvents(ctx.userId, { companyId: r.value.id });
    if (!show.company) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `couldn't load the page for "${input.company}"`,
        "show_company:not_found:company",
      );
    }
    return {
      content: `Put ${r.value.slug}'s page on the user's screen. Nothing else happens — this is display only.`,
      events: show.events,
      statusLines: [
        `Pulled up ${formatFocusRefToken("company", r.value.id, show.company.name)}.`,
      ],
    };
  },
};
