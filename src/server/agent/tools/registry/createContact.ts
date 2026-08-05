import { z } from "zod";

import { createContact } from "@/server/entities/contacts/createContact";
import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

// The create_contact input shape.
const CONTACT_FIELDS = {
  name: z.string().min(1),
  role: z.string().optional(),
  agency: z.string().optional(),
  company: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().optional(),
  channel: z.string().optional(),
  notes: z.string().optional(),
};

export const createContactTool: ToolDef<{
  name: string;
  role?: string;
  agency?: string;
  company?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  channel?: string;
  notes?: string;
}> = {
  name: "create_contact",
  affectsViewedState: true,
  description:
    "Create a Contact (recruiter, hiring manager, referrer). `name` is required; everything else is optional. For external recruiters at agencies, store the agency name in `agency` — DO NOT create a Company row for the agency (we only model hiring companies on the watchlist, not the agencies that pitch them). For in-house recruiters at a Company we already track, set `company` (its slug) and leave `agency` empty. `channel` records how they reached you (e.g. 'LinkedIn DM', 'cold email', 'referral via Alex'). Returns the new contact's slug — pass it to create_opportunities or attach_contact_to_opportunity.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      role: {
        type: "string",
        description: "e.g. 'Recruiter', 'Hiring Manager'.",
      },
      agency: {
        type: "string",
        description:
          "Recruiting agency name (e.g. 'McKenley Talent'). Use for external recruiters; leave empty for in-house.",
      },
      company: {
        type: "string",
        description:
          "Optional company slug — set only if the contact is in-house at a Company on the watchlist.",
      },
      email: { type: "string" },
      phone: { type: "string" },
      linkedinUrl: { type: "string" },
      channel: { type: "string" },
      notes: { type: "string" },
    },
    required: ["name"],
  },
  parser: z.object(CONTACT_FIELDS),
  async handle(input, ctx) {
    const { name, company, ...rest } = input;
    // Resolve the optional company slug to a FK id before writing.
    let companyId: string | undefined;
    if (company) {
      const companyResolved = await resolveCompanyBySlug(ctx.userId, company);
      if (!companyResolved.ok) {
        return slugLookupError(companyResolved);
      }
      companyId = companyResolved.value.id;
    }
    const contact = await createContact({
      userId: ctx.userId,
      name,
      companyId,
      ...rest,
    });
    const where = contact.agency
      ? ` (agency: ${contact.agency})`
      : contact.companySlug
        ? ` (in-house at ${contact.companySlug})`
        : "";
    return {
      content: `created contact ${contact.slug ?? contact.id} "${contact.name}"${where}`,
    };
  },
};
