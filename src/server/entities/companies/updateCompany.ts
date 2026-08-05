// Domain core for editing a watchlisted Company's table fields. Shared behind the
// update_company tool: owns the slug re-derivation on a name change, the
// greenhouseSlug re-derivation on a URL change, the field diff, and the write.
// Works purely in ids — the agent's company slug → id translation is the tool's
// job.

import { prisma } from "@/server/db/prisma";
import { extractGreenhouseSlugFromBoardUrl } from "@/server/scrape/ats";

import { companySlug } from "./companySlug";

export type UpdateCompanyFieldsPatch = {
  url?: string;
  name?: string;
  logoUrl?: string | null;
  description?: string | null;
};

export type UpdateCompanyFieldsResult =
  { ok: true; finalName: string } | { ok: false; reason: "not_found" };

export async function updateCompanyFields(args: {
  companyId: string;
  patch: UpdateCompanyFieldsPatch;
}): Promise<UpdateCompanyFieldsResult> {
  const { companyId, patch } = args;

  const existing = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true, slug: true },
  });
  if (!existing) return { ok: false, reason: "not_found" };

  const finalName = patch.name ?? existing.name;
  // Only re-derive slug if the name actually changed — memory notes are keyed by
  // slug, so be deliberate about changing it.
  const nextSlug =
    patch.name && patch.name !== existing.name
      ? companySlug(finalName) || existing.slug
      : existing.slug;

  const data: {
    sourceUrl?: string;
    greenhouseSlug?: string | null;
    name?: string;
    slug?: string;
    logoUrl?: string | null;
    description?: string | null;
  } = {};
  if (patch.url !== undefined) {
    data.sourceUrl = patch.url;
    // Re-derive greenhouseSlug whenever sourceUrl changes — null for non-
    // Greenhouse URLs so a switch off Greenhouse clears the stale slug rather
    // than leaving it stranded.
    data.greenhouseSlug = extractGreenhouseSlugFromBoardUrl(patch.url);
  }
  if (patch.name !== undefined) {
    data.name = finalName;
    data.slug = nextSlug;
  }
  if (patch.logoUrl !== undefined) data.logoUrl = patch.logoUrl;
  if (patch.description !== undefined) data.description = patch.description;

  await prisma.company.update({ where: { id: companyId }, data });
  return { ok: true, finalName };
}
