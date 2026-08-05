// Commit a verified board URL onto the Company row — the ONE place a hunted URL
// lands, whether it came from the hunter or from a user's disambiguation pick.
//
// Two @unique columns make this more than an update, and skipping either throws
// a raw Prisma error at the user:
//   - `Company.slug`: adopting a canonical slug another company already holds
//     collides. Keeping the current slug is harmless, so that's the fallback.
//   - `Company.sourceUrl`: the URL is unique ACROSS USERS, so a board another
//     user already mapped cannot be attached to this stub. Instead the stub is
//     deleted and this user's watchlist entry is re-pointed at the row that
//     already holds it — which is also how two users end up sharing one
//     Company's scraped jobs.
//
// Returns the company the caller should carry on with: on attach that is a
// DIFFERENT id than the one passed in.

import { prisma } from "@/server/db/prisma";
import { slugify } from "@/server/memory/paths";
import { appendMemory } from "@/server/memory/store";
import { extractGreenhouseSlugFromBoardUrl } from "@/server/scrape/ats";
import { nowDate } from "@/utils/now";

import { attachToExistingCompany } from "./statusWrites";

export type CommittedCompany = {
  companyId: string;
  slug: string;
  sourceUrl: string;
  canonicalName: string;
  logoUrl: string | null;
  logoVerifiedAt: Date | null;
  attachedToExisting: boolean;
};

export async function commitHuntedUrl(args: {
  userId: string;
  companyId: string;
  currentSlug: string;
  found: {
    canonicalName: string;
    sourceUrl: string;
    shortDescription: string;
    longNotes?: string | null;
  };
}): Promise<CommittedCompany> {
  const { userId, companyId, currentSlug, found } = args;

  const existingWithUrl = await prisma.company.findFirst({
    where: { sourceUrl: found.sourceUrl, id: { not: companyId } },
    select: {
      id: true,
      slug: true,
      name: true,
      logoUrl: true,
      logoVerifiedAt: true,
    },
  });
  if (existingWithUrl) {
    await attachToExistingCompany({
      stubCompanyId: companyId,
      existingCompanyId: existingWithUrl.id,
      userId,
    });
    // No memory append here: the surviving row was hunted on its own way in and
    // already carries its notes. Writing this hunt's copy would duplicate them.
    return {
      companyId: existingWithUrl.id,
      slug: existingWithUrl.slug,
      sourceUrl: found.sourceUrl,
      canonicalName: existingWithUrl.name,
      logoUrl: existingWithUrl.logoUrl,
      logoVerifiedAt: existingWithUrl.logoVerifiedAt,
      attachedToExisting: true,
    };
  }

  const candidateSlug = slugify(found.canonicalName) || currentSlug;
  const collision =
    candidateSlug !== currentSlug
      ? await prisma.company.findFirst({
          where: { slug: candidateSlug, id: { not: companyId } },
          select: { id: true },
        })
      : null;
  const nextSlug = collision ? currentSlug : candidateSlug;

  const updated = await prisma.company.update({
    where: { id: companyId },
    data: {
      sourceUrl: found.sourceUrl,
      greenhouseSlug: extractGreenhouseSlugFromBoardUrl(found.sourceUrl),
      name: found.canonicalName,
      slug: nextSlug,
      description: found.shortDescription,
      basicInfoHuntedAt: nowDate(),
    },
    select: { logoUrl: true, logoVerifiedAt: true },
  });

  if (found.longNotes && found.longNotes.length > 0) {
    try {
      await appendMemory(userId, `companies/${nextSlug}.md`, found.longNotes);
    } catch (err) {
      console.warn(`[commitHuntedUrl] memory append failed:`, err);
    }
  }

  return {
    companyId,
    slug: nextSlug,
    sourceUrl: found.sourceUrl,
    canonicalName: found.canonicalName,
    logoUrl: updated.logoUrl,
    logoVerifiedAt: updated.logoVerifiedAt,
    attachedToExisting: false,
  };
}
