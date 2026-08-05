// Deterministic ATS board-slug probe.
//
// Board slugs frequently can't be derived from a company name (Greenhouse
// `sourcegraph91`, Ashby domain-style `qdrant.tech`), but the EASY cases don't
// need an LLM guessing them one at a time — that burns sub-agent turns and only
// tries the domain-style form if the model thinks of it.
//
// So: make the easy cases deterministic and free. Generate the obvious
// name- and domain-derived slug candidates, cross them with the slug-guessable
// ATS providers, and test_scrape the lot in parallel. No LLM, no web_search.
// The hunter calls it first (via the `probe_ats` tool) and only escalates to
// web_search / fetch_url / test_scrape-on-the-careers-page when it comes back empty —
// which is the genuinely-unguessable case (the `sourcegraph91` numeric suffix
// has no derivable pattern; only a web_search finds it).
//
// Workday is deliberately absent: its boards live at
// {tenant}.{shard}.myworkdayjobs.com/{site} where the shard (wd1..wd108+) is an
// unguessable data-center number, so there's nothing to probe — that's what
// resolveBoardFromCareersPage is for (reached by running test_scrape on the
// company's careers page). Same for iCIMS' per-company careers domain.

import { testScrape } from "./index";

import type { AtsProvider } from "./types";

type AtsProbeHit = {
  provider: AtsProvider;
  slug: string;
  url: string;
  jobCount: number;
  companyName: string;
  sampleTitles: string[];
};

// Generic trailing tokens we strip when deriving a slug — "Cognition Labs" is
// hosted at `cognition`, not `cognitionlabs`, far more often than not. We only
// strip when there's another word left (so "Labs" the company keeps its name).
const STRIP_SUFFIX_TOKENS = new Set([
  "inc",
  "llc",
  "ltd",
  "labs",
  "lab",
  "ai",
  "io",
  "hq",
  "technologies",
  "technology",
  "tech",
  "corp",
  "corporation",
  "co",
  "company",
  "group",
  "systems",
  "software",
]);

// Ordered, deduped slug candidates derived from a company name and (optionally)
// its website domain. Ordering is "most likely first" so callers that cap the
// list keep the best guesses. Pure — no I/O — so it's unit-testable on its own.
function generateSlugCandidates(name: string, domain?: string): string[] {
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    const v = raw.toLowerCase().trim();
    if (v.length > 0 && !out.includes(v)) out.push(v);
  };

  const words = name
    .toLowerCase()
    .replace(/['']/g, "")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);

  // Drop trailing generic tokens (Labs / Inc / AI / …) but never the last word.
  const core = [...words];
  while (core.length > 1 && STRIP_SUFFIX_TOKENS.has(core[core.length - 1])) {
    core.pop();
  }

  push(core.join("")); // cognition  (after stripping "labs")
  push(core.join("-")); // cognition (single) / cognition-labs-style multiwords
  push(core[0]); // first word alone
  push(words.join("")); // cognitionlabs — suffix kept, in case the suffix is load-bearing
  push(words.join("-")); // cognition-labs

  if (domain) {
    const host = domain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")
      .trim();
    if (host) {
      push(host); // qdrant.tech — Ashby uses the literal domain as a slug
      push(host.split(".")[0]); // qdrant
    }
  }

  return out.slice(0, 8);
}

// Provider URL builders. Each returns null when the slug shape can't be a valid
// board URL for that provider (e.g. Teamtailor needs a bare subdomain, so a
// domain-style `qdrant.tech` slug isn't applicable there). The built URL must
// be one detectAts() recognizes — these mirror the canonical forms in the ats/ provider files.
const PROBE_PROVIDERS: Array<{
  provider: AtsProvider;
  build: (slug: string) => string | null;
}> = [
  { provider: "greenhouse", build: (s) => `https://boards.greenhouse.io/${s}` },
  { provider: "lever", build: (s) => `https://jobs.lever.co/${s}` },
  { provider: "ashby", build: (s) => `https://jobs.ashbyhq.com/${s}` },
  {
    provider: "teamtailor",
    // Slug is a subdomain here — a dotted domain-style slug doesn't apply.
    build: (s) => (s.includes(".") ? null : `https://${s}.teamtailor.com/`),
  },
  { provider: "gem", build: (s) => `https://jobs.gem.com/${s}` },
];

// Build the deduped (provider, slug, url) probe list. Exposed for testing the
// cross-product without firing network requests.
function buildAtsProbeTargets(
  candidates: string[],
): Array<{ provider: AtsProvider; slug: string; url: string }> {
  const seen = new Set<string>();
  const targets: Array<{ provider: AtsProvider; slug: string; url: string }> =
    [];
  for (const slug of candidates) {
    for (const { provider, build } of PROBE_PROVIDERS) {
      const url = build(slug);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      targets.push({ provider, slug, url });
    }
  }
  return targets;
}

// Minimum real jobs for a board to count as a hit — mirrors the hunter's own
// success criterion (a single "open application" template entry isn't a board).
const MIN_JOBS = 2;
// Safety bound on parallel external fetches for one probe. 8 candidates × 5
// providers is 40 in the worst case; cap so a probe never fans out unbounded.
const MAX_PROBE_TARGETS = 24;

// Probe the slug-guessable ATSes for a company in parallel. Returns every board
// that produced ≥2 real jobs — the caller (hunter) is responsible for
// validating each hit against the *right* company (companyName / sampleTitles),
// since a name-derived slug can collide with an unrelated company on the same
// ATS (the "Arbor" failure mode). Never throws — a failed test_scrape is just a
// non-hit.
export async function probeAtsBoards(args: {
  name: string;
  domain?: string;
}): Promise<AtsProbeHit[]> {
  const candidates = generateSlugCandidates(args.name, args.domain);
  const targets = buildAtsProbeTargets(candidates).slice(0, MAX_PROBE_TARGETS);

  const settled = await Promise.allSettled(
    targets.map(async (t) => {
      const r = await testScrape(t.url);
      if (!r.ok || r.jobCount < MIN_JOBS) return null;
      return {
        provider: r.provider,
        slug: t.slug,
        url: t.url,
        jobCount: r.jobCount,
        companyName: r.companyName,
        sampleTitles: r.sampleTitles,
      } satisfies AtsProbeHit;
    }),
  );

  const hits: AtsProbeHit[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) hits.push(s.value);
  }
  // Strongest signal first.
  hits.sort((a, b) => b.jobCount - a.jobCount);
  return hits;
}
