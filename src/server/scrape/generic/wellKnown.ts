// Endpoint paths worth trying blind on a board's own origin, before anything
// expensive. The highest-yield tier of the probe by a wide margin: most
// long-tail board software publishes an unauthenticated JSON list at a
// conventional path, and ~20 parallel GETs costs less than one page render.
//
// Two kinds of entry live here and they're deliberately mixed. Some are
// GENERIC conventions (`/jobs.json`, `?format=json`) that any framework might
// answer. The rest are the KNOWN shapes of specific board software we haven't
// written a provider for — Recruitee, Personio, Breezy, WP Job Manager. A
// named shape here is not a provider: it's a guess with a good prior, and it
// still has to survive the job-shape detector like any other candidate.
//
// The pay-off for naming them is `familyKey`, which is what turns
// /admin/board-readers into a priority list — twelve companies behind
// "wp-job-manager" is the signal that it has earned a real provider file.

export type WellKnownProbe = {
  // Appended to the board's origin, or (when relative) to its path.
  path: string;
  // Coarse board-software family, recorded on the reader row when this hits.
  familyKey?: string;
  // Relative to the board URL's own path rather than the origin.
  relativeToPath?: boolean;
};

export const WELL_KNOWN_PROBES: WellKnownProbe[] = [
  // Generic same-origin JSON conventions.
  { path: "/api/jobs", familyKey: "api-jobs" },
  { path: "/api/jobs.json", familyKey: "api-jobs" },
  { path: "/api/v1/jobs", familyKey: "api-jobs" },
  { path: "/api/positions", familyKey: "api-positions" },
  { path: "/api/openings", familyKey: "api-openings" },
  { path: "/api/careers", familyKey: "api-careers" },
  { path: "/jobs.json", familyKey: "jobs-json" },
  { path: "/careers.json", familyKey: "jobs-json" },
  { path: "/positions.json", familyKey: "jobs-json" },
  { path: "/postings.json", familyKey: "pinpoint" },

  // WordPress. Two shapes because the plugin ecosystem split: WP Job Manager
  // registers `job-listings`, several themes register a bare `jobs` type.
  {
    path: "/wp-json/wp/v2/job-listings?per_page=100",
    familyKey: "wp-job-manager",
  },
  { path: "/wp-json/wp/v2/jobs?per_page=100", familyKey: "wp-jobs" },

  // Named board software with a public JSON list and no provider file yet.
  { path: "/api/offers/", familyKey: "recruitee" },
  { path: "/api/v1/offers", familyKey: "recruitee" },
  { path: "/json", familyKey: "breezy" },
  { path: "/xml", familyKey: "personio" },
  { path: "/jobs/rss", familyKey: "rss" },
  { path: "/jobs.rss", familyKey: "rss" },
  { path: "/careers/feed", familyKey: "rss" },
  { path: "/feed/jobs", familyKey: "rss" },

  // The page itself, asked for JSON. Some SSR stacks content-negotiate.
  { path: "?format=json", relativeToPath: true, familyKey: "format-json" },
  { path: ".json", relativeToPath: true, familyKey: "path-json" },
];

// Absolute URLs to try for one board. Deduped, since several entries collapse
// to the same URL depending on the board's path shape.
export function wellKnownUrls(boardUrl: string): Array<{
  url: string;
  familyKey?: string;
}> {
  let base: URL;
  try {
    base = new URL(boardUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: Array<{ url: string; familyKey?: string }> = [];
  const cleanPath = base.pathname.replace(/\/+$/, "");

  for (const probe of WELL_KNOWN_PROBES) {
    let candidate: string;
    if (probe.relativeToPath) {
      candidate = probe.path.startsWith("?")
        ? `${base.origin}${base.pathname}${probe.path}`
        : `${base.origin}${cleanPath}${probe.path}`;
    } else {
      candidate = `${base.origin}${probe.path}`;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(
      probe.familyKey
        ? { url: candidate, familyKey: probe.familyKey }
        : { url: candidate },
    );
  }

  // The board's own path is often already a tenant scope
  // (`careers.acme.com/en/jobs`), so try the conventional suffixes under it too.
  if (cleanPath && cleanPath !== "") {
    for (const suffix of ["/api/jobs", "/jobs.json", "/api/offers/"]) {
      const candidate = `${base.origin}${cleanPath}${suffix}`;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push({ url: candidate, familyKey: "path-scoped" });
    }
  }

  return out;
}
