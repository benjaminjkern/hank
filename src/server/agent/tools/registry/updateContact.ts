import { z } from "zod";

import { updateContact } from "@/server/entities/contacts/updateContact";
import {
  resolveCompanyBySlug,
  resolveContactBySlug,
} from "@/server/entities/resolveBySlug";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const updateContactTool: ToolDef<{
  contact: string;
  name?: string;
  role?: string;
  agency?: string;
  company?: string | null;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  channel?: string;
  notes?: string;
}> = {
  name: "update_contact",
  affectsViewedState: true,
  description:
    "Update a Contact's fields. `contact` is the contact's slug. Pass only the fields you want to change. Pass `company: null` to clear the company link (e.g. when a contact left their employer), or a company slug to set it.",
  inputSchema: {
    type: "object",
    properties: {
      contact: { type: "string", description: "The contact's slug." },
      name: { type: "string" },
      role: { type: "string" },
      agency: { type: "string" },
      company: {
        type: ["string", "null"],
        description: "Company slug to link, or null to clear.",
      },
      email: { type: "string" },
      phone: { type: "string" },
      linkedinUrl: { type: "string" },
      channel: { type: "string" },
      notes: { type: "string" },
    },
    required: ["contact"],
  },
  parser: z.object({
    contact: z.string(),
    name: z.string().min(1).optional(),
    role: z.string().optional(),
    agency: z.string().optional(),
    company: z.string().nullable().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    linkedinUrl: z.string().optional(),
    channel: z.string().optional(),
    notes: z.string().optional(),
  }),
  async handle({ contact: contactSlug, company, ...patch }, ctx) {
    const contactResolved = await resolveContactBySlug(ctx.userId, contactSlug);
    if (!contactResolved.ok) {
      return slugLookupError(contactResolved);
    }
    // Resolve the company slug → FK id (or null to clear).
    let companyId: string | null | undefined = undefined;
    if (company !== undefined) {
      if (company === null) {
        companyId = null;
      } else {
        const companyResolved = await resolveCompanyBySlug(ctx.userId, company);
        if (!companyResolved.ok) {
          return slugLookupError(companyResolved);
        }
        companyId = companyResolved.value.id;
      }
    }
    const result = await updateContact({
      userId: ctx.userId,
      contactId: contactResolved.value.id,
      patch: { ...patch, companyId },
    });
    if (!result.ok) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `(no contact found for "${contactSlug}")`,
        "update_contact:not_found:contact",
      );
    }
    if (result.changedFields.length === 0) {
      return { content: "no fields to update" };
    }
    return {
      content: `updated contact ${contactResolved.value.slug ?? contactResolved.value.id} fields: ${result.changedFields.join(", ")}`,
    };
  },
};
