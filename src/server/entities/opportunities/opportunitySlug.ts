// Opportunity.slug derivation + minting: per-user unique (`@@unique([userId, slug])`),
// derived from the lead label. Single-candidate — mintSlug adds numeric suffixes on
// collision; a P2002 here means the same user already has that slug.

import { prisma } from "@/server/db/prisma";
import { mintSlug } from "@/server/platform/slug/mintSlug";
import { capSlug, slugify } from "@/server/platform/slug/slugify";

export async function mintOpportunitySlug(
  opportunityId: string,
  label: string,
): Promise<string> {
  const base = capSlug(slugify(label, { maxLength: 60 }) || "lead");
  return await mintSlug(opportunityId, [base], (slug) =>
    prisma.opportunity.update({
      where: { id: opportunityId },
      data: { slug },
    }),
  );
}
