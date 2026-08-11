// "Is this array a list of job postings?" — the single most dangerous judgement
// in the generic path, because getting it wrong is SILENT: a nav menu and a
// board both look like arrays of objects with a name and a link, and picking
// the wrong one produces a scrape that succeeds and is entirely fiction.
//
// So the bar is deliberately high and the rejections are explicit. Three
// independent things must hold — a plausible TITLE column, a plausible IDENTITY
// column, and at least one corroborating job-ish column — and any one of the
// hard negatives kills the candidate outright.
//
// DISTINCTNESS is what does most of the work. Nav menus, breadcrumbs, category
// filters and department lists all have title-ish keys; what they don't have is
// ~unique values in both a title column AND an id/url column across dozens of
// rows. `{name:"Engineering"}` × 8 fails; 40 rows of distinct role titles pass.
//
// Pure and synchronous, so scripts/ats/jobshape-cases.ts can exercise every
// branch offline with no network.

import { isRecord } from "@/utils/guards";

// Normalized (lowercased, separators stripped) so `job_title`, `jobTitle` and
// `Job Title` collapse to one entry.
const TITLE_KEYS = new Set([
  "title",
  "name",
  "jobtitle",
  "postingtitle",
  "positiontitle",
  "position",
  "role",
  "headline",
  "label",
]);

// Anything that could identify a posting well enough to build a URL from.
const IDENTITY_KEYS = new Set([
  "url",
  "absoluteurl",
  "applyurl",
  "joburl",
  "hostedurl",
  "jobposturl",
  "link",
  "href",
  "permalink",
  "id",
  "jobid",
  "postingid",
  "requisitionid",
  "externalpath",
  "slug",
  "shortcode",
  "reference",
  "refnumber",
  "code",
]);

// Identity keys that are already a URL (or a path) rather than an opaque id.
const URLISH_KEYS = new Set([
  "url",
  "absoluteurl",
  "applyurl",
  "joburl",
  "hostedurl",
  "jobposturl",
  "link",
  "href",
  "permalink",
  "externalpath",
]);

const LOCATION_KEYS = new Set([
  "location",
  "locations",
  "locationname",
  "joblocation",
  "city",
  "office",
  "offices",
  "workplace",
  "region",
  "country",
  "place",
  "primarylocation",
]);

const DEPARTMENT_KEYS = new Set([
  "department",
  "departments",
  "team",
  "teams",
  "category",
  "function",
  "jobfunction",
  "discipline",
  "businessunit",
  "practice",
]);

const DESCRIPTION_KEYS = new Set([
  "description",
  "descriptionhtml",
  "descriptionplain",
  "jobdescription",
  "content",
  "body",
  "summary",
  "details",
  "jobdescriptiontext",
]);

const DATE_KEYS = new Set([
  "dateposted",
  "publishedat",
  "postedat",
  "createdat",
  "updatedat",
  "publisheddate",
  "firstpublished",
  "opendate",
  "livedate",
]);

const EMPLOYMENT_KEYS = new Set([
  "employmenttype",
  "jobtype",
  "type",
  "contracttype",
  "worktype",
  "schedule",
  "commitment",
  "employmentstatus",
]);

const COMPENSATION_KEYS = new Set([
  "salary",
  "salaryrange",
  "compensation",
  "compensationrange",
  "pay",
  "payrange",
  "basesalary",
  "salarydescription",
]);

// Site-chrome labels. Two or more of these among the titles means the array is
// a navigation structure, whatever else it looks like.
const NAV_LABELS = new Set([
  "home",
  "about",
  "aboutus",
  "careers",
  "contact",
  "contactus",
  "privacy",
  "privacypolicy",
  "terms",
  "termsofservice",
  "blog",
  "login",
  "signin",
  "signup",
  "search",
  "news",
  "press",
  "support",
  "help",
  "faq",
  "cookies",
  "legal",
]);

const MIN_ITEMS = 2;
const MAX_ITEMS = 5000;
const SAMPLE_SIZE = 20;
const MIN_OBJECT_RATIO = 0.8;
const MIN_TITLE_DISTINCTNESS = 0.7;
const MIN_IDENTITY_DISTINCTNESS = 0.9;
const MIN_TITLE_CHARS = 3;
const MAX_TITLE_CHARS = 200;
const LONG_DESCRIPTION_CHARS = 200;

export type JobKeyMapping = {
  title: string;
  // Whichever identity key won. `identityIsUrl` says whether it can be used
  // directly or has to be interpolated into a URL template.
  identity: string;
  identityIsUrl: boolean;
  location?: string;
  department?: string;
  description?: string;
  employmentType?: string;
  compensation?: string;
};

export type JobArrayMatch = {
  items: Record<string, unknown>[];
  keys: JobKeyMapping;
  // Dot path from whatever root was searched. "" when the root IS the array.
  path: string;
  score: number;
};

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Test ONE array. Returns null — never a partial match — so a caller can't
// accidentally proceed on a maybe.
export function looksLikeJobArray(value: unknown): JobArrayMatch | null {
  if (!Array.isArray(value)) return null;
  if (value.length < MIN_ITEMS || value.length > MAX_ITEMS) return null;

  const objects = value.filter(isRecord);
  if (objects.length < value.length * MIN_OBJECT_RATIO) return null;

  const sample = objects.slice(0, SAMPLE_SIZE);
  // A list of near-empty objects is a lookup table or an id index, not a board.
  const thin = sample.filter((o) => Object.keys(o).length <= 2).length;
  if (thin > sample.length * 0.5) return null;

  const title = pickTitleKey(sample);
  if (!title) return null;

  const titles = sample
    .map((o) => asText(o[title.key]))
    .filter((s): s is string => s != null);
  if (navLabelCount(titles) >= 2) return null;
  if (new Set(titles.map((t) => t.toLowerCase())).size === 1) return null;

  const identity = pickIdentityKey(sample);
  if (!identity) return null;

  const corroborating = pickCorroborating(sample);
  if (corroborating.count === 0) return null;

  const keys: JobKeyMapping = {
    title: title.key,
    identity: identity.key,
    identityIsUrl: identity.isUrl,
    ...corroborating.keys,
  };

  return {
    items: objects,
    keys,
    path: "",
    // More corroborating columns, cleaner distinctness, and more rows all raise
    // confidence; length is logged so a 2000-row board doesn't automatically
    // beat a well-formed 30-row one.
    score:
      corroborating.count *
      title.distinctness *
      Math.log10(objects.length + 10),
  };
}

// Walk a parsed blob for the best job-shaped array anywhere inside it. Bounded
// on both depth and nodes — a Next.js payload can be megabytes of nested state,
// and an unbounded walk over one is a hang, not a search.
const MAX_DEPTH = 8;
const MAX_NODES = 20_000;

export function findJobArray(root: unknown): JobArrayMatch | null {
  let best: JobArrayMatch | null = null;
  let nodes = 0;

  const visit = (node: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH || nodes++ > MAX_NODES) return;
    if (Array.isArray(node)) {
      const match = looksLikeJobArray(node);
      if (match) {
        const candidate: JobArrayMatch = { ...match, path };
        if (best === null || better(candidate, best)) best = candidate;
      }
      // Keep descending even on a hit: a wrapper array often contains the real
      // one, and the scorer decides between them.
      for (let i = 0; i < Math.min(node.length, 50); i++) {
        visit(node[i], path ? `${path}.${i}` : String(i), depth + 1);
      }
      return;
    }
    if (!isRecord(node)) return;
    for (const [k, v] of Object.entries(node)) {
      visit(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };

  visit(root, "", 0);
  return best;
}

// Higher score wins; ties break toward the SHALLOWER path (the outer array is
// usually the board and the inner one a facet of it), then toward more rows.
function better(candidate: JobArrayMatch, incumbent: JobArrayMatch): boolean {
  if (candidate.score !== incumbent.score) {
    return candidate.score > incumbent.score;
  }
  const depth = (m: JobArrayMatch) =>
    m.path === "" ? 0 : m.path.split(".").length;
  if (depth(candidate) !== depth(incumbent)) {
    return depth(candidate) < depth(incumbent);
  }
  return candidate.items.length > incumbent.items.length;
}

// -- column pickers -----------------------------------------------------------

function pickTitleKey(
  sample: Record<string, unknown>[],
): { key: string; distinctness: number } | null {
  let best: { key: string; distinctness: number } | null = null;
  for (const key of keysAcross(sample)) {
    if (!TITLE_KEYS.has(normalizeKey(key))) continue;
    const values = sample
      .map((o) => asText(o[key]))
      .filter((s): s is string => s != null);
    // Present on most rows, or it isn't the title column.
    if (values.length < sample.length * 0.8) continue;
    if (
      values.some(
        (v) => v.length < MIN_TITLE_CHARS || v.length > MAX_TITLE_CHARS,
      )
    ) {
      continue;
    }
    // A URL in the title column means we matched a link list.
    if (values.some(isUrlish)) continue;
    const distinctness =
      new Set(values.map((v) => v.toLowerCase())).size / values.length;
    if (distinctness < MIN_TITLE_DISTINCTNESS) continue;
    if (best == null || distinctness > best.distinctness) {
      best = { key, distinctness };
    }
  }
  return best;
}

function pickIdentityKey(
  sample: Record<string, unknown>[],
): { key: string; isUrl: boolean } | null {
  let best: { key: string; isUrl: boolean; distinctness: number } | null = null;
  for (const key of keysAcross(sample)) {
    const norm = normalizeKey(key);
    if (!IDENTITY_KEYS.has(norm)) continue;
    const values = sample
      .map((o) => asText(o[key]))
      .filter((s): s is string => s != null);
    if (values.length < sample.length * 0.9) continue;
    const distinctness = new Set(values).size / values.length;
    if (distinctness < MIN_IDENTITY_DISTINCTNESS) continue;
    const isUrl = URLISH_KEYS.has(norm) || values.every(isUrlOrPath);
    // A real URL beats an opaque id — it needs no template, so nothing has to
    // be verified before it can be trusted as a sourceUrl.
    const rank = (u: boolean) => (u ? 1 : 0);
    if (
      best == null ||
      rank(isUrl) > rank(best.isUrl) ||
      (rank(isUrl) === rank(best.isUrl) && distinctness > best.distinctness)
    ) {
      best = { key, isUrl, distinctness };
    }
  }
  return best ? { key: best.key, isUrl: best.isUrl } : null;
}

function pickCorroborating(sample: Record<string, unknown>[]): {
  count: number;
  keys: Partial<Omit<JobKeyMapping, "title" | "identity" | "identityIsUrl">>;
} {
  const keys: Partial<
    Omit<JobKeyMapping, "title" | "identity" | "identityIsUrl">
  > = {};
  let count = 0;
  const all = keysAcross(sample);

  const firstMatching = (
    set: Set<string>,
    predicate?: (values: unknown[]) => boolean,
  ): string | undefined => {
    for (const key of all) {
      if (!set.has(normalizeKey(key))) continue;
      const values = sample.map((o) => o[key]).filter((v) => v != null);
      if (values.length === 0) continue;
      if (predicate && !predicate(values)) continue;
      return key;
    }
    return undefined;
  };

  keys.location = firstMatching(LOCATION_KEYS);
  keys.department = firstMatching(DEPARTMENT_KEYS);
  keys.employmentType = firstMatching(EMPLOYMENT_KEYS);
  keys.compensation = firstMatching(COMPENSATION_KEYS);
  // A description column only corroborates if it actually holds prose — a
  // `summary` of eight words is a card subtitle, not a posting body.
  keys.description = firstMatching(DESCRIPTION_KEYS, (values) =>
    values.some((v) => {
      const s = asText(v);
      return s != null && s.length > LONG_DESCRIPTION_CHARS;
    }),
  );
  const dateKey = firstMatching(DATE_KEYS);

  for (const k of [
    keys.location,
    keys.department,
    keys.employmentType,
    keys.compensation,
    keys.description,
    dateKey,
  ]) {
    if (k) count++;
  }
  for (const k of Object.keys(keys) as Array<keyof typeof keys>) {
    if (keys[k] == null) delete keys[k];
  }
  return { count, keys };
}

// Union of keys, in first-seen order, so a column missing from row 0 is still
// considered. Ordering matters: it decides which of two equally-valid
// synonyms wins.
function keysAcross(sample: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const obj of sample) {
    for (const k of Object.keys(obj)) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

// Scalars become text; a nested object yields its most name-like leaf, which is
// how `location: {city:"Berlin"}` still reads as a location.
export function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 1 ? asText(value[0]) : null;
  }
  if (isRecord(value)) {
    for (const k of ["name", "label", "title", "city", "text", "value"]) {
      const v = value[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

// The leaf key inside a nested value that asText() would have picked, so a
// recipe can address it by path (`location.city`) instead of guessing.
export function nestedTextKey(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const k of ["name", "label", "title", "city", "text", "value"]) {
    if (typeof value[k] === "string" && value[k].trim()) return k;
  }
  return null;
}

function navLabelCount(titles: string[]): number {
  return titles.filter((t) => NAV_LABELS.has(normalizeKey(t))).length;
}

function isUrlish(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function isUrlOrPath(s: string): boolean {
  return isUrlish(s) || s.startsWith("/");
}
