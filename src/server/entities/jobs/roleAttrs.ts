// The CANONICAL job attributes: the scalars every part of the app pulls off a
// Job *together* — location, department, compensation, employmentType.
//
// They live here as ONE list because they travel as a set, in five shapes: a
// Prisma select, a column→field map, a column write, the `key=value` block an
// LLM call renders above a posting, and a compact display line. Spelled out per
// call site (as they were, in ~20 places), a fifth attribute lands in the schema
// and silently misses half of them — with no typecheck error, because every site
// is independently well-typed.
//
// Adding one: a line in ROLE_ATTR_FIELDS + a line in ROLE_ATTR_SELECT (which has
// to stay an object literal for Prisma to infer the result type — `satisfies`
// keeps it honest), then fix the compile errors that raises in toRoleAttrs /
// roleAttrColumns. Every loader, prompt block, and catalog picks it up free.
//
// Two things still mirror the list by hand, deliberately: the agent-facing JSON
// schemas on the create_jobs / update_job tools (each field needs its own prose
// description aimed at the model) and each ATS provider's field mapping (only
// the provider knows where its board puts the value).
//
// NOT here: `Job.attributes` and `Job.enrichedAttributes`. Those are open-ended
// bags, rendered by attributePairs() — and WHICH of them a call site includes is
// a per-site judgement, stated in that file's header.

// `key` is the name every in-app shape uses and every agent reads; `column` is
// where it comes off the Job row. They differ for exactly one field: `location`
// is stored as `locationAndArrangement`, because it blends place + work
// arrangement (remote / hybrid / on-site).
const ROLE_ATTR_FIELDS = [
  ["location", "locationAndArrangement"],
  ["department", "department"],
  ["compensation", "compensation"],
  ["employmentType", "employmentType"],
] as const;

type RoleAttrField = (typeof ROLE_ATTR_FIELDS)[number];
export type RoleAttrKey = RoleAttrField[0];
export type RoleAttrColumn = RoleAttrField[1];

// The role's attributes as everything downstream of the DB spells them —
// sub-agent inputs, view models, widget payloads. Intersect this into a shape
// (`RoleAttrs & { title: string }`) rather than re-listing the fields.
export type RoleAttrs = { [K in RoleAttrKey]: string | null };

// The same values under their Job column names — what a `select` returns and
// what an `update`/`create` writes.
export type RoleAttrColumns = { [K in RoleAttrColumn]: string | null };

// Spread into any Job select that wants the attributes:
// `select: { id: true, title: true, ...ROLE_ATTR_SELECT }`.
export const ROLE_ATTR_SELECT = {
  locationAndArrangement: true,
  department: true,
  compensation: true,
  employmentType: true,
} as const satisfies Record<RoleAttrColumn, true>;

// Nullish-tolerant: a job read through an optional relation is all-nulls rather
// than a special case, so a caller never hand-writes the empty shape.
export function toRoleAttrs(
  row: RoleAttrColumns | null | undefined,
): RoleAttrs {
  return {
    location: row?.locationAndArrangement ?? null,
    department: row?.department ?? null,
    compensation: row?.compensation ?? null,
    employmentType: row?.employmentType ?? null,
  };
}

// Column writes for a CREATE or a full overwrite: an absent attribute writes
// null. That's what both a create and a re-scrape upsert want — the scrape is
// the whole truth about the posting, so a field the board stopped returning is
// gone, not retained.
export function roleAttrColumns(src: Partial<RoleAttrs>): RoleAttrColumns {
  return {
    locationAndArrangement: src.location ?? null,
    department: src.department ?? null,
    compensation: src.compensation ?? null,
    employmentType: src.employmentType ?? null,
  };
}

// Column writes for a PATCH: an absent key is left untouched, an explicit null
// clears. The correction tools mean "don't touch" by omitting a field, so they
// can't use roleAttrColumns — a null-writing patch would wipe three columns to
// fix one.
export function roleAttrColumnPatch(
  patch: Partial<RoleAttrs>,
): Partial<RoleAttrColumns> {
  const out: Partial<RoleAttrColumns> = {};
  for (const [key, column] of ROLE_ATTR_FIELDS) {
    const value = patch[key];
    if (value !== undefined) out[column] = value;
  }
  return out;
}

// The `key=value` metadata block an LLM call renders above a posting. Nulls drop
// out — unless `emptyPlaceholder` is set, which the enrich pass uses to tell the
// extractor which fields are MISSING and therefore worth pulling out of the body.
export function roleAttrPairs(
  attrs: RoleAttrs,
  opts?: { emptyPlaceholder?: string },
): string[] {
  return ROLE_ATTR_FIELDS.flatMap(([key]) => {
    const value = attrs[key]?.trim();
    if (value) return [`${key}=${value}`];
    return opts?.emptyPlaceholder ? [`${key}=${opts.emptyPlaceholder}`] : [];
  });
}

// The compact one-line render — " · "-joined values, nulls dropped, no keys.
// Used where the attributes are context on a role the reader already has named
// (a past-application catalog, a sibling application), so the keys would be
// noise.
export function formatRoleAttrs(attrs: RoleAttrs): string {
  return ROLE_ATTR_FIELDS.map(([key]) => attrs[key]?.trim() ?? "")
    .filter(Boolean)
    .join(" · ");
}
