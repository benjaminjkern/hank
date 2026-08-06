// Job.slug derivation + minting. The slug is `{company}-{title}` with a smart
// disambiguation suffix (location → department → numeric) for duplicate titles at
// one company. Minted once at creation and immutable afterwards — a re-scrape that
// changes a Job's title does NOT re-slug it (the slug is a stable permalink).
// Mirror of companySlug.ts; jobs need the alternate candidates (company/opportunity/
// contact slugs are single-candidate), so the candidate-building lives here and the
// generic retry loop lives in slug/mintSlug.ts.

import { bulkUpdate } from "@/server/db/bulkUpdate";
import { prisma } from "@/server/db/prisma";
import { mintSlug, slugCandidateAt } from "@/server/platform/slug/mintSlug";
import { capSlug, slugify } from "@/server/platform/slug/slugify";

// Named candidates in priority order: `{company}-{title}`, then `…-{location}`
// and `…-{department}` for duplicate-title disambiguation. mintSlug appends
// numeric suffixes once these are exhausted.
export type JobSlugParts = {
  companySlug?: string | null;
  companyName?: string | null;
  title: string;
  location?: string | null;
  department?: string | null;
};

// Guard against a pathological walk when every candidate is somehow taken; the
// row's cuid is always free. Mirrors the same escape in mintSlug.
const MAX_CANDIDATE_WALK = 500;

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

// One row's mint, letting the unique index arbitrate each candidate. Private:
// mintJobSlugs is the only entry, and this is the tail it falls back to — a
// caller reaching past it would be choosing round trips per row on purpose.
async function mintJobSlug(
  jobId: string,
  parts: JobSlugParts,
): Promise<string> {
  return await mintSlug(jobId, jobSlugCandidates(parts), (slug) =>
    prisma.job.update({ where: { id: jobId }, data: { slug } }),
  );
}

// Mint slugs for MANY jobs in two statements instead of one write per row — the
// scrape path mints a whole board at once, where per-row is hundreds of round
// trips. Returns jobId → slug.
//
// The per-row minter's race-safety comes from ATTEMPTING the write and catching
// the unique violation, because a read-then-write pre-check races. This keeps
// that guarantee by making the pre-read an OPTIMIZATION rather than the
// arbiter: the unique index still decides. If the bulk write loses a race (or
// lands on a numeric suffix the pre-read didn't cover) the single statement
// fails atomically — nothing half-written — and every row falls back to the
// one-at-a-time minter, which arbitrates against the live index. Flat in the
// common case, correct in the rare one.
export async function mintJobSlugs(
  rows: ReadonlyArray<{ jobId: string; parts: JobSlugParts }>,
): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map();

  const candidatesByJob = rows.map((r) => ({
    jobId: r.jobId,
    candidates: jobSlugCandidates(r.parts),
  }));

  // One read covering every NAMED candidate. Numeric suffixes are deliberately
  // not pre-read — reaching one means a title collided past its location AND
  // department fallbacks, which is what the catch below is for.
  const named = [...new Set(candidatesByJob.flatMap((c) => c.candidates))];
  const takenRows = await prisma.job.findMany({
    where: { slug: { in: named } },
    select: { slug: true },
  });
  const taken = new Set(
    takenRows.flatMap((r) => (r.slug == null ? [] : [r.slug])),
  );

  const assigned = new Map<string, string>();
  for (const { jobId, candidates } of candidatesByJob) {
    for (let i = 0; ; i++) {
      const slug =
        i > MAX_CANDIDATE_WALK ? jobId : slugCandidateAt(candidates, jobId, i);
      // Adding to `taken` also dedupes WITHIN the batch — two identical titles
      // on one board are each other's collision before the DB ever sees them.
      if (!taken.has(slug)) {
        taken.add(slug);
        assigned.set(jobId, slug);
        break;
      }
    }
  }

  try {
    await bulkUpdate(
      "Job",
      "id",
      [...assigned].map(([jobId, slug]) => ({ key: jobId, patch: { slug } })),
    );
    return assigned;
  } catch {
    const out = new Map<string, string>();
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- the collision fallback: each mint arbitrates against the live unique index, which is the one thing that can't be batched
      out.set(row.jobId, await mintJobSlug(row.jobId, row.parts));
    }
    return out;
  }
}
