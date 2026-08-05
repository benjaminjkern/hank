// Slug resolvers. Every main-agent tool handler that takes an entity slug runs
// one of these at the top: the LLM passes a human-readable slug (preferred;
// that's all it's ever shown), but a raw cuid still resolves too — so replayed
// ids from old chat history / widget markers keep working, and rows whose slug
// hasn't been backfilled yet resolve by id. Hence the param name slugOrCuid.
//
// Every resolver is BATCH-first: `resolve<Entity>sBySlug` takes the whole list
// and answers it in one query (plus at most one hint query when something
// missed), and the singular form is a one-element call into it. A tool holding N
// slugs must use the batch — N singular calls is N round trips, and against this
// remote Postgres that is the difference between 40ms and 40ms × N.
//
// Failure reports what didn't resolve and which slugs would have, and stops
// there — the agent-facing sentence and its audit key are the tool layer's
// (`slugLookupError` in agent/tools/lib). Offering the valid slugs is what lets
// the model self-correct in the same turn, so the hint list is worth the extra
// query even though only two of the resolvers can produce one cheaply.

import { prisma } from "@/server/db/prisma";

export type SlugLookupEntity =
  "company" | "job" | "opportunity" | "contact" | "job_interaction";

export type SlugLookupFail = {
  ok: false;
  // Which resolver failed; the caller words the message from this.
  entity: SlugLookupEntity;
  // What the caller passed, untrimmed — quoted back so the model sees the
  // string it actually sent.
  attempted: string;
  // Slugs that WOULD have resolved. Empty when this resolver has no cheap hint
  // query, or the user has none of that entity.
  availableSlugs: string[];
};
export type SlugLookup<T> = { ok: true; value: T } | SlugLookupFail;

type ResolvedCompany = { id: string; name: string; slug: string };
type ResolvedJob = {
  id: string;
  title: string;
  companyId: string | null;
  slug: string | null;
};
type ResolvedOpportunity = {
  id: string;
  label: string;
  slug: string | null;
};
type ResolvedContact = { id: string; name: string; slug: string | null };

// ── Company (global row; scoped to the user's watchlist for hints) ──────────
export async function resolveCompaniesBySlug(
  userId: string,
  slugsOrCuids: string[],
): Promise<Map<string, SlugLookup<ResolvedCompany>>> {
  const trimmed = [...new Set(slugsOrCuids.map((s) => s.trim()))];
  const out = new Map<string, SlugLookup<ResolvedCompany>>();
  if (trimmed.length === 0) return out;

  const rows = await prisma.company.findMany({
    where: { OR: [{ slug: { in: trimmed } }, { id: { in: trimmed } }] },
    select: { id: true, name: true, slug: true },
  });
  const byKey = new Map<string, ResolvedCompany>();
  for (const r of rows) {
    byKey.set(r.id, r);
    if (r.slug) byKey.set(r.slug, r);
  }

  const missed = trimmed.filter((t) => !byKey.has(t));
  // One hint query for the whole batch, and only when something actually missed.
  const availableSlugs =
    missed.length === 0
      ? []
      : (
          await prisma.company.findMany({
            where: { companyInteractions: { some: { userId } } },
            select: { slug: true },
            orderBy: { name: "asc" },
            take: 12,
          })
        ).map((h) => h.slug);

  for (const key of trimmed) {
    const hit = byKey.get(key);
    out.set(
      key,
      hit
        ? { ok: true, value: hit }
        : { ok: false, entity: "company", attempted: key, availableSlugs },
    );
  }
  return out;
}

export async function resolveCompanyBySlug(
  userId: string,
  slugOrCuid: string,
): Promise<SlugLookup<ResolvedCompany>> {
  const map = await resolveCompaniesBySlug(userId, [slugOrCuid]);
  return (
    map.get(slugOrCuid.trim()) ?? {
      ok: false,
      entity: "company",
      attempted: slugOrCuid,
      availableSlugs: [],
    }
  );
}

// ── Job (global row) ─────────────────────────────────────────────────────────
// `_userId` is ignored on purpose: Job is global, so there is nothing to scope
// the lookup by. It stays in the signature to match the other three resolvers —
// callers pass it, then scope the JobInteraction they load with the id.
export async function resolveJobBySlug(
  _userId: string,
  slugOrCuid: string,
): Promise<SlugLookup<ResolvedJob>> {
  const trimmed = slugOrCuid.trim();
  const found = await prisma.job.findFirst({
    where: { OR: [{ slug: trimmed }, { id: trimmed }] },
    select: { id: true, title: true, companyId: true, slug: true },
  });
  if (found) return { ok: true, value: found };
  return {
    ok: false,
    entity: "job",
    attempted: slugOrCuid,
    availableSlugs: [],
  };
}

// Batch variant for log_job_events — preserves its partial-success behavior
// (process the resolved subset, report the unknown slugs).
export async function resolveJobsBySlug(
  slugsOrCuids: string[],
): Promise<{ resolved: ResolvedJob[]; unknown: string[] }> {
  const trimmed = slugsOrCuids.map((r) => r.trim());
  const rows = await prisma.job.findMany({
    where: { OR: [{ slug: { in: trimmed } }, { id: { in: trimmed } }] },
    select: { id: true, title: true, companyId: true, slug: true },
  });
  const bySlug = new Map<string, ResolvedJob>();
  const byId = new Map<string, ResolvedJob>();
  for (const r of rows) {
    if (r.slug) bySlug.set(r.slug, r);
    byId.set(r.id, r);
  }
  const resolved: ResolvedJob[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const slugOrCuid of trimmed) {
    const hit = bySlug.get(slugOrCuid) ?? byId.get(slugOrCuid);
    if (!hit) {
      unknown.push(slugOrCuid);
      continue;
    }
    if (seen.has(hit.id)) continue; // de-dupe if the same job was passed twice
    seen.add(hit.id);
    resolved.push(hit);
  }
  return { resolved, unknown };
}

// ── Opportunity (per-user row) ──────────────────────────────────────────────
export async function resolveOpportunitiesBySlug(
  userId: string,
  slugsOrCuids: string[],
): Promise<Map<string, SlugLookup<ResolvedOpportunity>>> {
  const trimmed = [...new Set(slugsOrCuids.map((s) => s.trim()))];
  const out = new Map<string, SlugLookup<ResolvedOpportunity>>();
  if (trimmed.length === 0) return out;

  const rows = await prisma.opportunity.findMany({
    where: { userId, OR: [{ slug: { in: trimmed } }, { id: { in: trimmed } }] },
    select: { id: true, label: true, slug: true },
  });
  const byKey = new Map<string, ResolvedOpportunity>();
  for (const r of rows) {
    byKey.set(r.id, r);
    if (r.slug) byKey.set(r.slug, r);
  }

  const missed = trimmed.filter((t) => !byKey.has(t));
  const availableSlugs =
    missed.length === 0
      ? []
      : (
          await prisma.opportunity.findMany({
            where: { userId },
            select: { slug: true },
            orderBy: { updatedAt: "desc" },
            take: 12,
          })
        )
          .map((h) => h.slug)
          .filter((slug): slug is string => Boolean(slug));

  for (const key of trimmed) {
    const hit = byKey.get(key);
    out.set(
      key,
      hit
        ? { ok: true, value: hit }
        : { ok: false, entity: "opportunity", attempted: key, availableSlugs },
    );
  }
  return out;
}

export async function resolveOpportunityBySlug(
  userId: string,
  slugOrCuid: string,
): Promise<SlugLookup<ResolvedOpportunity>> {
  const map = await resolveOpportunitiesBySlug(userId, [slugOrCuid]);
  return (
    map.get(slugOrCuid.trim()) ?? {
      ok: false,
      entity: "opportunity",
      attempted: slugOrCuid,
      availableSlugs: [],
    }
  );
}

// ── Contact (per-user row) ──────────────────────────────────────────────────
export async function resolveContactsBySlug(
  userId: string,
  slugsOrCuids: string[],
): Promise<Map<string, SlugLookup<ResolvedContact>>> {
  const trimmed = [...new Set(slugsOrCuids.map((s) => s.trim()))];
  const out = new Map<string, SlugLookup<ResolvedContact>>();
  if (trimmed.length === 0) return out;

  const rows = await prisma.contact.findMany({
    where: { userId, OR: [{ slug: { in: trimmed } }, { id: { in: trimmed } }] },
    select: { id: true, name: true, slug: true },
  });
  const byKey = new Map<string, ResolvedContact>();
  for (const r of rows) {
    byKey.set(r.id, r);
    if (r.slug) byKey.set(r.slug, r);
  }

  for (const key of trimmed) {
    const hit = byKey.get(key);
    out.set(
      key,
      hit
        ? { ok: true, value: hit }
        : { ok: false, entity: "contact", attempted: key, availableSlugs: [] },
    );
  }
  return out;
}

export async function resolveContactBySlug(
  userId: string,
  slugOrCuid: string,
): Promise<SlugLookup<ResolvedContact>> {
  const map = await resolveContactsBySlug(userId, [slugOrCuid]);
  return (
    map.get(slugOrCuid.trim()) ?? {
      ok: false,
      entity: "contact",
      attempted: slugOrCuid,
      availableSlugs: [],
    }
  );
}

// ── JobInteraction, addressed by a job slug (for sourceJob on opportunities) ──
export type ResolvedJobInteraction = {
  jobInteractionId: string;
  jobId: string;
  title: string;
};

export async function resolveJobInteractionsFromJobSlugs(
  userId: string,
  slugsOrCuids: string[],
): Promise<Map<string, SlugLookup<ResolvedJobInteraction>>> {
  const trimmed = [...new Set(slugsOrCuids.map((s) => s.trim()))];
  const out = new Map<string, SlugLookup<ResolvedJobInteraction>>();
  if (trimmed.length === 0) return out;

  const { resolved, unknown } = await resolveJobsBySlug(trimmed);
  const jobByKey = new Map<string, ResolvedJob>();
  for (const j of resolved) {
    jobByKey.set(j.id, j);
    if (j.slug) jobByKey.set(j.slug, j);
  }

  const interactions = await prisma.jobInteraction.findMany({
    where: { userId, jobId: { in: resolved.map((j) => j.id) } },
    select: { id: true, jobId: true },
  });
  const interactionByJobId = new Map(interactions.map((i) => [i.jobId, i.id]));

  for (const key of trimmed) {
    const job = jobByKey.get(key);
    if (!job) {
      out.set(key, {
        ok: false,
        entity: "job",
        attempted: key,
        availableSlugs: [],
      });
      continue;
    }
    const jobInteractionId = interactionByJobId.get(job.id);
    out.set(
      key,
      jobInteractionId
        ? {
            ok: true,
            value: { jobInteractionId, jobId: job.id, title: job.title },
          }
        : {
            ok: false,
            entity: "job_interaction",
            attempted: key,
            availableSlugs: [],
          },
    );
  }
  void unknown;
  return out;
}

export async function resolveJobInteractionFromJobSlug(
  userId: string,
  slugOrCuid: string,
): Promise<SlugLookup<ResolvedJobInteraction>> {
  const map = await resolveJobInteractionsFromJobSlugs(userId, [slugOrCuid]);
  return (
    map.get(slugOrCuid.trim()) ?? {
      ok: false,
      entity: "job",
      attempted: slugOrCuid,
      availableSlugs: [],
    }
  );
}
