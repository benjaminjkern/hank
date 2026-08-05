// Domain core for editing a Contact's fields. Shared behind the update_contact
// tool: applies a partial patch. Works purely in ids; patch semantics per field
// are `undefined` = leave unchanged, `null` = clear (companyId only). Mirror of
// entities/opportunities/updateOpportunity.

import { prisma } from "@/server/db/prisma";

export type UpdateContactPatch = {
  name?: string;
  role?: string;
  agency?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  channel?: string;
  notes?: string;
  // undefined = leave unchanged; null = clear the company link; id = set it.
  companyId?: string | null;
};

export type UpdateContactResult =
  { ok: true; changedFields: string[] } | { ok: false; reason: "not_found" };

const SCALAR_FIELDS = [
  "name",
  "role",
  "agency",
  "email",
  "phone",
  "linkedinUrl",
  "channel",
  "notes",
] as const;

export async function updateContact(args: {
  userId: string;
  contactId: string;
  patch: UpdateContactPatch;
}): Promise<UpdateContactResult> {
  const { userId, contactId, patch } = args;

  const existing = await prisma.contact.findFirst({
    where: { id: contactId, userId },
    select: { id: true },
  });
  if (!existing) return { ok: false, reason: "not_found" };

  const data: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }
  if (patch.companyId !== undefined) data.companyId = patch.companyId;

  // The FK column is `companyId`; the agent thinks in terms of "company".
  const changedFields = Object.keys(data).map((k) =>
    k === "companyId" ? "company" : k,
  );
  if (changedFields.length === 0) return { ok: true, changedFields };

  await prisma.contact.update({ where: { id: contactId }, data });
  return { ok: true, changedFields };
}
