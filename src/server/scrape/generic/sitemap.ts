// robots.txt → sitemap → job detail URLs. The slowest probe tier and the last
// one tried, but the one that reaches boards nothing else can: a server-rendered
// careers site with no API, no state blob and no feed still has to be indexable,
// so its postings are in a sitemap.
//
// It is also the only tier that pulls dozens of pages off one host, so it is
// the only one that honors robots.txt Disallow. A single list endpoint gets a
// log-and-proceed (blanket `Disallow: /api/` is near-universal and isn't aimed
// at us); crawling 60 detail pages is a different kind of ask.

import { fetchText } from "../ats/shared";

import type { TimeBudget } from "./budget";

// Path fragments that mark a job DETAIL url. Ordered by how specific they are —
// the first one with enough hits wins, so `/job/` beats `/careers/` on a site
// that has both.
const JOB_PATH_FRAGMENTS = [
  "/job/",
  "/jobs/",
  "/vacancy/",
  "/vacancies/",
  "/opening/",
  "/openings/",
  "/position/",
  "/positions/",
  "/role/",
  "/opportunity/",
  "/career/",
  "/careers/",
];

// A detail URL ends in a slug, not a bare section. `/jobs/` is the index;
// `/jobs/senior-engineer-123` is a posting.
const MIN_SLUG_CHARS = 3;
const MIN_JOB_URLS = 2;
// One level of sitemap-index recursion. Deeper is a site big enough that its
// board is behind a real API we should be finding another way.
const MAX_INDEX_FOLLOWS = 3;
export const SITEMAP_URL_CAP = 60;
// A sitemap is a static file; anything slower than this is a host that isn't
// going to answer usefully within the probe's budget anyway.
const SITEMAP_FETCH_TIMEOUT_MS = 8_000;

export function sitemapLocs(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    out.push(m[1].trim());
  }
  return out;
}

export type SitemapFind = {
  sitemapUrl: string;
  pathContains: string;
  jobUrls: string[];
  // The sitemap held more matching URLs than we kept.
  truncated: boolean;
};

// Sitemap discovery walks several documents in sequence, so it takes the
// probe's budget and stops rather than spending what's left of the scrape.
export async function findJobsViaSitemap(
  boardUrl: string,
  budget: TimeBudget,
): Promise<SitemapFind | null> {
  let origin: string;
  try {
    origin = new URL(boardUrl).origin;
  } catch {
    return null;
  }

  const robots = await fetchRobots(origin);
  if (budget.expired()) return null;
  const candidates = [
    ...robots.sitemaps,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/jobs-sitemap.xml`,
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    if (budget.expired()) return null;
    seen.add(candidate);
    const found = await scanSitemap(candidate, robots, seen, budget);
    if (found) return found;
  }
  return null;
}

async function scanSitemap(
  sitemapUrl: string,
  robots: RobotsRules,
  seen: Set<string>,
  budget: TimeBudget,
  depth = 0,
): Promise<SitemapFind | null> {
  if (budget.expired()) return null;
  const res = await fetchText(
    sitemapUrl,
    { headers: { Accept: "application/xml,text/xml,*/*" } },
    SITEMAP_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) return null;
  const locs = sitemapLocs(res.text);
  if (locs.length === 0) return null;

  const direct = pickJobUrls(locs);
  if (direct) return { sitemapUrl, ...direct };

  // A sitemap index: follow the children whose names suggest jobs first, so a
  // 40-sitemap index doesn't cost 40 fetches to find `jobs-sitemap.xml`.
  if (depth >= 1) return null;
  const children = locs
    .filter((l) => l.endsWith(".xml") && !seen.has(l))
    .sort((a, b) => jobbiness(b) - jobbiness(a))
    .slice(0, MAX_INDEX_FOLLOWS);
  for (const child of children) {
    seen.add(child);
    const found = await scanSitemap(child, robots, seen, budget, depth + 1);
    if (found) return found;
  }
  return null;
}

function jobbiness(url: string): number {
  return /job|career|vacan|position|opening/i.test(url) ? 1 : 0;
}

function pickJobUrls(
  locs: string[],
): { pathContains: string; jobUrls: string[]; truncated: boolean } | null {
  for (const fragment of JOB_PATH_FRAGMENTS) {
    const matches = locs.filter((loc) => isDetailUrl(loc, fragment));
    if (matches.length < MIN_JOB_URLS) continue;
    return {
      pathContains: fragment,
      jobUrls: matches.slice(0, SITEMAP_URL_CAP),
      truncated: matches.length > SITEMAP_URL_CAP,
    };
  }
  return null;
}

function isDetailUrl(loc: string, fragment: string): boolean {
  const idx = loc.indexOf(fragment);
  if (idx === -1) return false;
  const tail = loc.slice(idx + fragment.length).replace(/\/+$/, "");
  // Something must follow the section, and it must be a leaf — `/jobs/eng/`
  // is a category page, `/jobs/eng-lead-4821` is a posting.
  return tail.length >= MIN_SLUG_CHARS && !tail.includes("/");
}

// -- robots.txt ---------------------------------------------------------------

export type RobotsRules = {
  sitemaps: string[];
  disallow: string[];
};

export async function fetchRobots(origin: string): Promise<RobotsRules> {
  const res = await fetchText(
    `${origin}/robots.txt`,
    { headers: { Accept: "text/plain" } },
    SITEMAP_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) return { sitemaps: [], disallow: [] };
  return parseRobots(res.text, origin);
}

// Only the wildcard group. We're not a named crawler, and a per-agent group we
// don't match is not ours to obey or ignore.
export function parseRobots(text: string, origin: string): RobotsRules {
  const sitemaps: string[] = [];
  const disallow: string[] = [];
  let inWildcardGroup = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "sitemap" && value) {
      sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      inWildcardGroup = value === "*";
      continue;
    }
    if (key === "disallow" && inWildcardGroup && value) {
      disallow.push(new URL(value, origin).pathname);
    }
  }
  return { sitemaps, disallow };
}

export function isDisallowed(url: string, robots: RobotsRules): boolean {
  if (robots.disallow.length === 0) return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return robots.disallow.some((rule) => path.startsWith(rule));
}
