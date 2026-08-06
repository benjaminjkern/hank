// Generic slug minter: assigns a unique slug to an already-created row by trying
// candidates in order and letting the DB's unique constraint arbitrate.
//
// Race-safety: some create paths (the parallel scrape upsert) mint concurrently,
// so two siblings can generate the same base at once. We don't pre-check with
// findUnique (that races); instead we write a candidate, catch the P2002 unique
// violation, and fall through to the next. First writer wins; the loser retries
// with the next suffix. After the named candidates are exhausted we append
// numeric suffixes (`-2`, `-3`, …); a pathological run falls back to the row's
// own cuid (always unique).
//
// Per-entity code supplies the candidate list and the `write` that persists the
// slug on its row — see entities/{jobs,opportunities,contacts}/*Slug.ts. Company
// slugs do NOT use this: their slug is a derived dedup identity minted inside the
// create transaction (see entities/companies/companySlug.ts).

import { Prisma } from "@/generated/prisma/client";

import { capSlug } from "./slugify";

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

// Persists the chosen slug on the row; must throw P2002 when the slug already
// exists in the row's uniqueness scope (global for Job, per-user for
// Opportunity/Contact) so the loop can fall through to the next candidate.
export type SlugWriter = (slug: string) => Promise<unknown>;

// The order candidates are tried in, by index: the named candidates first, then
// `{base}-2`, `{base}-3`, … It's a function of the index rather than a loop
// body so a BATCH minter can walk the same order against a set of known-taken
// slugs — one definition of the order, so the two paths can't hand the same row
// different slugs. See entities/jobs/jobSlug.ts → mintJobSlugs.
export function slugCandidateAt(
  candidates: string[],
  fallbackId: string,
  index: number,
): string {
  const named = candidates.length ? candidates : [fallbackId];
  if (index < named.length) return named[index];
  return capSlug(`${named[0]}-${index - named.length + 2}`);
}

// candidates: named candidates in priority order; candidates[0] is the base that
// numeric suffixes append to (`{base}-2`, `{base}-3`, …). fallbackId: the row's
// cuid, the guaranteed-unique escape after too many collisions.
export async function mintSlug(
  fallbackId: string,
  candidates: string[],
  write: SlugWriter,
): Promise<string> {
  for (let i = 0; ; i++) {
    const slug = slugCandidateAt(candidates, fallbackId, i);
    try {
      // eslint-disable-next-line no-await-in-loop -- each candidate is only tried because the previous one collided
      await write(slug);
      return slug;
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Guard against a pathological loop; the cuid id is always unique.
        if (i > 500) {
          // eslint-disable-next-line no-await-in-loop -- last-resort fallback, reached only after every candidate collided
          await write(fallbackId);
          return fallbackId;
        }
        continue;
      }
      throw e;
    }
  }
}
