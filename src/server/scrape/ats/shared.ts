import { assertPublicUrl } from "@/server/platform/net/assertPublicUrl";

import { scrapeFetchSignal } from "../scrapeSignal";

import type {
  ApplicationQuestionsEnvelope,
  AtsProvider,
  ScrapeResult,
  ScrapedCompany,
} from "../types";

// Deterministic per-ATS scraping, decomposed one file per provider under
// providers/. Zero LLM cost — we hit the well-known endpoints (JSON, GraphQL,
// or HTML) and shape responses into ScrapedCompany. This module holds the
// contract every provider implements plus the helpers they share; index.ts
// assembles the ordered registry and derives the public API from it.
//
// A provider's detect() returns an AtsHandler. Simple providers (a single JSON
// GET that contains everything) ship `jsonUrl` + `parse`; providers that need
// paging / GraphQL / multi-step fetches ship a `fetchAll` function that builds
// the ScrapedCompany itself. See providers/workday.ts and providers/gem.ts for
// the latter pattern.
export type AtsHandler =
  | {
      provider: AtsProvider;
      jsonUrl: string;
      parse: (data: unknown, slug: string) => ScrapedCompany;
    }
  | {
      provider: AtsProvider;
      fetchedUrl: string;
      fetchAll: () => Promise<ScrapeResult>;
    };

// Company-level context threaded into the questions fetchers. `greenhouseSlug`
// lets us recover the board slug for custom-domain Greenhouse integrations whose
// per-job URL has had its host stripped.
export type QuestionsHints = { greenhouseSlug?: string | null };

// The contract every ATS provider module implements. index.ts assembles the
// ordered registry from these and derives detectAts + fetchApplicationQuestions
// from it.
export type AtsProviderModule = {
  provider: AtsProvider;
  // Strict board detection for scraping. Returns an AtsHandler or null.
  detect: (url: string) => AtsHandler | null;
  // Questions routing. matchesQuestions may be broader than detect (e.g.
  // Greenhouse custom-domain URLs recovered via the slug hint). Absent → the
  // router returns {status:"unsupported"} for this provider's URLs by design.
  matchesQuestions?: (url: string, hints: QuestionsHints) => boolean;
  fetchQuestions?: (
    url: string,
    hints: QuestionsHints,
  ) => Promise<ApplicationQuestionsEnvelope>;
};

// How many real postings a URL must yield before it counts as a working board.
// One entry is almost always an "Open Application" / "Don't see your role?"
// template rather than a board. Every discovery path shares this number — the
// slug probe, the careers-page resolver, the hunter's own success criterion,
// and the generic probe — so they can't drift into disagreeing about what
// "works" means.
export const MIN_REAL_JOBS = 2;

// -- shared parsing helpers ----------------------------------------------

// Keys whose values are huge text blobs (already captured in rawContent) or
// pure noise — excluded from the raw attributes bag so it stays an at-a-glance
// metadata snapshot, not a second copy of the posting body.
const RAW_ATTR_SKIP = new Set<string>([
  // description / body blobs — live in rawContent already
  "descriptionHtml",
  "descriptionPlain",
  "description",
  "content",
  "descriptionBody",
  "descriptionBodyPlain",
  "additional",
  "additionalPlain",
  "opening",
  "openingPlain",
  "jobDescription",
  "compensationHtml",
  "jobPostSectionHtml",
  "lists",
  "descriptionParts",
  "salaryDescription",
  // noise / opaque internals
  "data_compliance",
  "similarJobs",
  "userAuthenticated",
  "questionnaireId",
  "jobPostingSiteId",
  "@context",
  "@type",
]);

// Dump a provider's raw job object into ScrapedJob.attributes: every top-level
// field that isn't a description blob or noise, values left in their native
// shape (nested objects/arrays preserved for audit — attributePairs() flattens
// them for the LLM). Intentionally NOT curated: capturing the raw response
// wholesale means a newly-added or drifted ATS can't silently drop a field just
// because nobody wired a column for it. The cleaned columns (location/comp/…)
// are the promoted view on top; overlap with them is deliberate. Returns
// undefined when nothing survives so the column stays NULL.
export function rawAttrs(
  obj: Record<string, unknown>,
  extraClose?: string[],
): Record<string, unknown> | undefined {
  const skip = extraClose
    ? new Set([...RAW_ATTR_SKIP, ...extraClose])
    : RAW_ATTR_SKIP;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k) || v == null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).length === 0
    )
      continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Shared fetch helper with abort + timeout, used by the bespoke fetchers
// below. Returns the response text + the actual fetched URL (after redirects)
// for diagnostics, or an error string.
//
// `signal` is applied AFTER the caller's `init` and is not overridable: it
// already carries the per-request timeout AND the ambient scrape abort, so a
// caller substituting its own would drop one or both. (It used to sit before
// the `...init` spread, where a caller passing `signal` would have silently
// disabled the timeout — nobody did, but the shape invited it.)
export async function fetchText(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<
  { ok: true; text: string; finalUrl: string } | { ok: false; error: string }
> {
  try {
    // SSRF guard: ATS fetchers reach hosts derived from agent/careers-page input
    // (iCIMS matches any host), so refuse internal targets before the request.
    await assertPublicUrl(url);
    const res = await fetch(url, {
      headers: { "User-Agent": "HankBot/0.1", ...(init.headers ?? {}) },
      redirect: "follow",
      ...init,
      signal: scrapeFetchSignal(timeoutMs),
    });
    if (!res.ok)
      return { ok: false, error: `${url}: ${res.status} ${res.statusText}` };
    const text = await res.text();
    return { ok: true, text, finalUrl: res.url || url };
  } catch (err) {
    return {
      ok: false,
      error: `${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
