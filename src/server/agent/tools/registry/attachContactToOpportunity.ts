import { z } from "zod";

import { linkContactsToOpportunity } from "@/server/entities/opportunities/linkContacts";
import {
  resolveContactBySlug,
  resolveOpportunityBySlug,
} from "@/server/entities/resolveBySlug";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

export const attachContactToOpportunityTool: ToolDef<{
  opportunity: string;
  contact: string;
}> = {
  name: "attach_contact_to_opportunity",
  affectsViewedState: true,
  description:
    "Link an existing Contact to an Opportunity (both by slug). Idempotent — re-attaching the same contact is a no-op. Use this when a second person (e.g. the actual hiring manager after a recruiter intro) enters an opportunity. The headline contact still lives on the lead's primary contact; this tool only adds to the additional-contacts list.",
  parser: z.object({
    opportunity: z.string().describe("The lead's slug."),
    contact: z.string().describe("The contact's slug."),
  }),
  async handle({ opportunity, contact }, ctx) {
    // resolve*BySlug already scope by userId, so a successful resolve proves
    // ownership — no second findFirst needed. The idempotent link write lives in
    // linkContactsToOpportunity.
    const opportunityResolved = await resolveOpportunityBySlug(
      ctx.userId,
      opportunity,
    );
    if (!opportunityResolved.ok) {
      return slugLookupError(opportunityResolved);
    }
    const contactResolved = await resolveContactBySlug(ctx.userId, contact);
    if (!contactResolved.ok) {
      return slugLookupError(contactResolved);
    }
    await linkContactsToOpportunity({
      opportunityId: opportunityResolved.value.id,
      contactIds: [contactResolved.value.id],
    });
    return {
      content: `attached ${contactResolved.value.slug ?? contactResolved.value.id} to ${opportunityResolved.value.slug ?? opportunityResolved.value.id}`,
    };
  },
};
