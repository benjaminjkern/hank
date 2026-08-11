// Try to read a board nothing recognizes, using only deterministic techniques —
// no LLM, no cost beyond network. This is the tier that has to carry the long
// tail, because everything it lands is a board recon never has to be paid for.
//
// It returns a RECIPE alongside the jobs, not just the jobs. For these cases
// the probe IS the inference — it has already worked out which array holds the
// postings and which key holds each field — so emitting the plan is free, and
// storing it turns a ~20-candidate fan-out into a single fetch next time.
//
// Ordered cheapest-and-most-likely first, with a wall-clock budget checked
// between tiers: runScrapeJobsForCompany caps the whole scrape at 90s, and
// discovery is the one part that must not eat it.

import { fetchText } from "../ats/shared";
import { htmlHeaders, runBoardRecipe } from "../recipe/runRecipe";

import { harvestBlobs } from "./blobs";
import { withTimeBudget, type TimeBudget } from "./budget";
import { parseFeedItems } from "./feed";
import {
  buildRecipe,
  planSourceUrl,
  withJsonLdDetail,
  withPageDetail,
  withTextDetail,
} from "./fieldMap";
import {
  findJobArray,
  looksLikeJobArray,
  type JobArrayMatch,
} from "./jobShape";
import {
  boardPathScope,
  fetchRobots,
  findJobsViaSitemap,
  isDisallowed,
} from "./sitemap";
import { wellKnownUrls } from "./wellKnown";

import type { BoardRecipe, ListSource } from "../recipe/types";
import type { ScrapedCompany } from "../types";

const PROBE_BUDGET_MS = 25_000;
// Well under fetchText's 20s default. Every request here is speculative, so a
// slow host must cost us a couple of seconds, not a fifth of the scrape's whole
// budget — one hanging candidate used to push a probe past 30s on its own.
const PROBE_FETCH_TIMEOUT_MS = 8_000;
const WELL_KNOWN_CONCURRENCY = 5;
// URL-ish literals pulled out of inline scripts. Capped hard — this tier is a
// guess, and each miss is a request against someone else's origin.
const SCRIPT_URL_CANDIDATES = 8;

export type ProbeOutcome =
  | { ok: true; recipe: BoardRecipe; data: ScrapedCompany; technique: string }
  | { ok: false; tried: string[] };

export async function probeGenericBoard(
  boardUrl: string,
): Promise<ProbeOutcome> {
  const budget = withTimeBudget(PROBE_BUDGET_MS);
  const tried: string[] = [];

  // Fetched at most once and shared by the blob, script-URL and JSON-LD tiers.
  let pageHtml: string | null | undefined;
  const html = async (): Promise<string | null> => {
    if (pageHtml === undefined) {
      const res = await fetchText(
        boardUrl,
        { headers: htmlHeaders() },
        PROBE_FETCH_TIMEOUT_MS,
      );
      pageHtml = res.ok ? res.text : null;
    }
    return pageHtml;
  };

  for (const tier of [
    () => tryWellKnown(boardUrl, tried, budget),
    () => tryEmbeddedBlobs(boardUrl, html, tried),
    () => tryScriptUrls(boardUrl, html, tried, budget),
    () => trySitemap(boardUrl, tried, budget),
  ]) {
    if (budget.expired()) break;
    const hit = await tier();
    if (hit) return hit;
  }

  return { ok: false, tried };
}

// -- tier 1: well-known endpoints --------------------------------------------

async function tryWellKnown(
  boardUrl: string,
  tried: string[],
  budget: TimeBudget,
): Promise<ProbeOutcome | null> {
  const candidates = wellKnownUrls(boardUrl);
  tried.push(`well-known endpoints (${candidates.length})`);

  for (let i = 0; i < candidates.length; i += WELL_KNOWN_CONCURRENCY) {
    if (budget.expired()) return null;
    const chunk = candidates.slice(i, i + WELL_KNOWN_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(async (candidate) => {
        const res = await fetchText(
          candidate.url,
          {
            headers: {
              Accept: "application/json, application/xml, text/xml, */*",
            },
          },
          PROBE_FETCH_TIMEOUT_MS,
        );
        if (!res.ok) return null;
        return { ...candidate, text: res.text };
      }),
    );
    for (const s of settled) {
      if (s.status !== "fulfilled" || !s.value) continue;
      const hit = await fromEndpointBody(
        s.value.text,
        s.value.url,
        boardUrl,
        s.value.familyKey,
      );
      if (hit) return await verify(hit.recipe, boardUrl, hit.technique);
    }
  }
  return null;
}

// One endpoint response → a recipe, if it holds a job-shaped array. Tries JSON
// first, then the XML feed shape, so `/xml` and `/jobs.rss` land here too.
async function fromEndpointBody(
  text: string,
  url: string,
  boardUrl: string,
  familyKey: string | undefined,
): Promise<{ recipe: BoardRecipe; technique: string } | null> {
  const trimmed = text.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const match = findJobArray(parsed);
    if (!match) return null;
    const recipe = await recipeFor(
      { kind: "json", url },
      match,
      boardUrl,
      familyKey,
    );
    return recipe ? { recipe, technique: `json endpoint ${url}` } : null;
  }

  if (trimmed.startsWith("<")) {
    const items = parseFeedItems(trimmed);
    if (!items) return null;
    const match = looksLikeJobArray(items);
    if (!match) return null;
    const recipe = await recipeFor(
      { kind: "feed", url },
      match,
      boardUrl,
      familyKey,
    );
    return recipe ? { recipe, technique: `xml feed ${url}` } : null;
  }

  return null;
}

// -- tier 2: embedded state blobs --------------------------------------------

async function tryEmbeddedBlobs(
  boardUrl: string,
  html: () => Promise<string | null>,
  tried: string[],
): Promise<ProbeOutcome | null> {
  const page = await html();
  if (!page) {
    tried.push("embedded blobs (page fetch failed)");
    return null;
  }
  const blobs = harvestBlobs(page);
  tried.push(`embedded blobs (${blobs.length} found)`);

  // Best-scoring array across all blobs, not first-hit: a page routinely
  // carries both a nav blob and the board.
  let best: { match: JobArrayMatch; list: ListSource; label: string } | null =
    null;
  for (const blob of blobs) {
    const match = findJobArray(blob.value);
    if (!match) continue;
    if (best == null || match.score > best.match.score) {
      best = {
        match,
        list: { kind: "embedded", url: boardUrl, blob: blob.spec },
        label: blob.label,
      };
    }
  }
  if (!best) return null;

  const recipe = await recipeFor(
    best.list,
    best.match,
    boardUrl,
    "embedded-state",
  );
  if (!recipe) return null;
  return await verify(recipe, boardUrl, `embedded blob ${best.label}`);
}

// -- tier 3: XHR-looking URLs in inline scripts -------------------------------

async function tryScriptUrls(
  boardUrl: string,
  html: () => Promise<string | null>,
  tried: string[],
  budget: TimeBudget,
): Promise<ProbeOutcome | null> {
  const page = await html();
  if (!page) return null;
  const candidates = scriptUrlCandidates(page, boardUrl);
  tried.push(`inline-script URLs (${candidates.length})`);
  if (candidates.length === 0) return null;

  const settled = await Promise.allSettled(
    candidates.map(async (url) => {
      if (budget.expired()) return null;
      const res = await fetchText(
        url,
        { headers: { Accept: "application/json" } },
        PROBE_FETCH_TIMEOUT_MS,
      );
      return res.ok ? { url, text: res.text } : null;
    }),
  );
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value) continue;
    const hit = await fromEndpointBody(
      s.value.text,
      s.value.url,
      boardUrl,
      "script-xhr",
    );
    if (hit) return await verify(hit.recipe, boardUrl, hit.technique);
  }
  return null;
}

// String literals in the page that look like a data endpoint. The poor man's
// XHR capture: the URL the SPA is about to call is usually sitting in its
// bundle config, so we can often reach it without ever rendering the page.
export function scriptUrlCandidates(html: string, boardUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /["'`](\/[^"'`\s]{4,120}|https?:\/\/[^"'`\s]{8,160})["'`]/g,
  )) {
    const raw = m[1];
    if (!/(api|graphql|jobs|careers|positions|openings|search)/i.test(raw)) {
      continue;
    }
    // Assets and page routes, not data.
    if (/\.(js|css|png|jpe?g|svg|woff2?|ico|map|webp)(\?|$)/i.test(raw))
      continue;
    let abs: string;
    try {
      abs = new URL(raw, boardUrl).toString();
    } catch {
      continue;
    }
    // Same-origin only. A cross-origin guess is someone else's server.
    try {
      if (new URL(abs).origin !== new URL(boardUrl).origin) continue;
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= SCRIPT_URL_CANDIDATES) break;
  }
  return out;
}

// -- tier 4: sitemap ----------------------------------------------------------

async function trySitemap(
  boardUrl: string,
  tried: string[],
  budget: TimeBudget,
): Promise<ProbeOutcome | null> {
  const scope = boardPathScope(boardUrl);
  const found = await findJobsViaSitemap(boardUrl, budget);
  tried.push(
    found ? `sitemap (${found.jobUrls.length} job URLs)` : "sitemap (none)",
  );
  if (!found) return null;

  // The one tier that pulls dozens of pages off a host, so it's the one that
  // honors Disallow rather than logging and proceeding.
  const origin = new URL(boardUrl).origin;
  const robots = await fetchRobots(origin);
  if (found.jobUrls.some((u) => isDisallowed(u, robots))) {
    tried.push("sitemap (robots.txt disallows the job paths)");
    return null;
  }

  const recipe: BoardRecipe = {
    version: 1,
    list: {
      kind: "sitemap",
      url: found.sitemapUrl,
      pathContains: found.pathContains,
      // Carried into the recipe, not just used during discovery — otherwise
      // the stored plan selects a wider set than the one that was verified.
      ...(scope === "/" ? {} : { pathPrefix: scope }),
    },
    itemsPath: "",
    fields: {
      // The sitemap carries only URLs; everything else comes from the detail
      // page's JSON-LD, which is why a sitemap recipe always has a detail step.
      sourceUrl: { path: "url" },
      title: { path: "detail.0.title" },
      rawContent: { path: "detail.0.description", transform: ["html-to-text"] },
      location: { path: "detail.0.jobLocation.address.addressLocality" },
      employmentType: {
        path: "detail.0.employmentType",
        transform: ["join-comma"],
      },
    },
    detail: { extract: { kind: "jsonld", atType: "JobPosting" } },
    familyKey: "jsonld-sitemap",
  };
  return await verify(recipe, boardUrl, `sitemap ${found.sitemapUrl}`);
}

// -- shared -------------------------------------------------------------------

// Assemble a recipe from a detected array, resolving the sourceUrl ladder.
//
// A board that publishes only an opaque id forces us to GUESS a URL template,
// and a guessed sourceUrl is the one thing that can't be allowed through on
// hope: it becomes `Job.sourceUrl @unique`, so a wrong one permanently orphans
// rows. So the guess is checked against live pages here, before the recipe
// exists at all.
async function recipeFor(
  list: ListSource,
  match: JobArrayMatch,
  boardUrl: string,
  familyKey: string | undefined,
): Promise<BoardRecipe | null> {
  const plan = planSourceUrl(match, boardUrl);
  if (plan.kind === "none") return null;
  if (plan.kind === "template" && !(await templateResolves(plan.samples))) {
    return null;
  }
  const base = buildRecipe({
    list,
    itemsPath: match.path,
    match,
    sourceUrl: plan.spec,
    ...(familyKey ? { familyKey } : {}),
  });
  // No body in the list rows — go get one. JSON-LD first: a detail page that
  // wants to be in Google for Jobs publishes it, and it's the richest source.
  if (base.fields.rawContent) return base;
  return withJsonLdDetail(base);
}

// Every sampled URL must actually resolve. Cheap (two GETs) and it's what
// separates "we inferred a URL shape" from "we know postings live there".
async function templateResolves(samples: string[]): Promise<boolean> {
  if (samples.length === 0) return false;
  const settled = await Promise.allSettled(
    samples.map((url) =>
      fetchText(url, { headers: htmlHeaders() }, PROBE_FETCH_TIMEOUT_MS),
    ),
  );
  return settled.every((s) => s.status === "fulfilled" && s.value.ok);
}

// Run the recipe for real and require it to produce usable postings. This is
// the probe's whole safety story: a detected array is a hypothesis, and nothing
// leaves this module until the runner + validate.ts have agreed on the output.
//
// The detail strategy gets a ladder rather than one shot, because "which shape
// does this board's posting page publish" is genuinely unknowable without
// fetching one: structured data → the page's own title+body → body only. A
// sitemap-sourced board needs the middle rung specifically, since its list rows
// are bare URLs and the TITLE has to come from the page too.
async function verify(
  recipe: BoardRecipe,
  boardUrl: string,
  technique: string,
): Promise<ProbeOutcome | null> {
  const attempts: BoardRecipe[] =
    recipe.detail?.extract.kind === "jsonld"
      ? [recipe, withPageDetail(recipe), withTextDetail(recipe)]
      : [recipe];
  for (const attempt of attempts) {
    const result = await runBoardRecipe(attempt, { boardUrl });
    if (result.ok) {
      return { ok: true, recipe: attempt, data: result.data, technique };
    }
  }
  return null;
}
