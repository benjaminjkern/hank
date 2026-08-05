// Contact.slug derivation + minting: per-user unique (`@@unique([userId, slug])`),
// derived from the contact name. Single-candidate — mintSlug adds numeric suffixes
// on collision.

import { prisma } from "@/server/db/prisma";
import { mintSlug } from "@/server/platform/slug/mintSlug";
import { capSlug, slugify } from "@/server/platform/slug/slugify";

export async function mintContactSlug(
  contactId: string,
  name: string,
): Promise<string> {
  const base = capSlug(slugify(name, { maxLength: 48 }) || "contact");
  return await mintSlug(contactId, [base], (slug) =>
    prisma.contact.update({ where: { id: contactId }, data: { slug } }),
  );
}
