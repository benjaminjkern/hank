// Job.slug derivation + minting. The slug is `{company}-{title}` with a smart
// disambiguation suffix (location → department → numeric) for duplicate titles at
// one company. Minted once at creation and immutable afterwards — a re-scrape that
// changes a Job's title does NOT re-slug it (the slug is a stable permalink).
// Mirror of companySlug.ts; jobs need the alternate candidates (company/opportunity/
// contact slugs are single-candidate), so the candidate-building lives here and the
// generic retry loop lives in slug/mintSlug.ts.

import { prisma } from "@/server/db/prisma";
import { mintSlug } from "@/server/platform/slug/mintSlug";
import { capSlug, slugify } from "@/server/platform/slug/slugify";

// Named candidates in priority order: `{company}-{title}`, then `…-{location}`
// and `…-{department}` for duplicate-title disambiguation. mintSlug appends
// numeric suffixes once these are exhausted.
type JobSlugParts = {
  companySlug?: string | null;
  companyName?: string | null;
  title: string;
  location?: string | null;
  department?: string | null;
};

function jobSlugBase(parts: JobSlugParts): string {
  const companyPart = parts.companySlug?.trim()
    ? slugify(parts.companySlug, { maxLength: 40 })
    : parts.companyName
      ? slugify(parts.companyName, { maxLength: 40 })
      : "";
  const titlePart = slugify(parts.title, { maxLength: 60 }) || "role";
  return capSlug([companyPart, titlePart].filter(Boolean).join("-") || "job");
}

function jobSlugCandidates(parts: JobSlugParts): string[] {
  const base = jobSlugBase(parts);
  const out = [base];
  const loc = parts.location ? slugify(parts.location, { maxLength: 24 }) : "";
  if (loc) out.push(capSlug(`${base}-${loc}`));
  const dept = parts.department
    ? slugify(parts.department, { maxLength: 24 })
    : "";
  if (dept) out.push(capSlug(`${base}-${dept}`));
  return out;
}

// Mint a globally-unique slug for an existing Job row (created with slug=null).
// Also lazily backfills a legacy null-slug job the scrape path touches.
export async function mintJobSlug(
  jobId: string,
  parts: JobSlugParts,
): Promise<string> {
  return await mintSlug(jobId, jobSlugCandidates(parts), (slug) =>
    prisma.job.update({ where: { id: jobId }, data: { slug } }),
  );
}
