// Domain core for creating a Contact (recruiter / hiring manager / referrer).
// Shared behind the create_contact tool: writes the row and mints its slug.
// Works purely in ids — the agent's company slug → FK id translation is the tool
// layer's job.

import { prisma } from "@/server/db/prisma";

import { mintContactSlug } from "./contactSlug";

export type CreateContactInput = {
  userId: string;
  name: string;
  // Already resolved from the agent's company slug (in-house contacts only).
  companyId?: string | null;
  role?: string;
  agency?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  channel?: string;
  notes?: string;
};

export type CreatedContact = {
  id: string;
  name: string;
  slug: string | null;
  agency: string | null;
  companySlug: string | null;
};

export async function createContact(
  input: CreateContactInput,
): Promise<CreatedContact> {
  const contact = await prisma.contact.create({
    data: {
      userId: input.userId,
      name: input.name,
      role: input.role,
      agency: input.agency,
      email: input.email,
      phone: input.phone,
      linkedinUrl: input.linkedinUrl,
      channel: input.channel,
      notes: input.notes,
      ...(input.companyId ? { companyId: input.companyId } : {}),
    },
    select: {
      id: true,
      name: true,
      agency: true,
      company: { select: { slug: true } },
    },
  });
  // Mint the slug after the row exists (retry-on-collision, so outside any tx).
  const slug = await mintContactSlug(contact.id, contact.name);
  return {
    id: contact.id,
    name: contact.name,
    slug,
    agency: contact.agency,
    companySlug: contact.company?.slug ?? null,
  };
}
