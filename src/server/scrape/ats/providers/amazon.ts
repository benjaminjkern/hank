import { htmlToText } from "@/utils/html";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type { ScrapeResult, ScrapedJob } from "../../types";

const AMAZON_RE = /^https?:\/\/(?:www\.)?amazon\.jobs(\/|$)/i;
// -- Amazon (amazon.jobs) -------------------------------------------------
//
// Single-tenant career site: amazon.jobs hosts Amazon + its subsidiaries (AWS,
// Audible, Ring, …) in one search index — there's no slug, the host IS the
// company. The SPA is backed by an unauthenticated JSON search endpoint:
//   GET https://www.amazon.jobs/en/search.json?result_limit=100&offset=N[&...]
// returns { hits, jobs: [...] } where each job carries the FULL description plus
// basic_qualifications / preferred_qualifications — list and detail in one call.
// `result_limit` caps ~100 (asking for more nulls the response), so we page by
// 100 and cap at AMAZON_MAX_JOBS (like Workday) with a truncatedAt diagnostic.
// Any search filters on the careers URL the user pasted (?base_query=…, country,
// category) are forwarded so a scoped board scrapes the scoped result set.
//
// Application questions: the apply flow lives at account.amazon.jobs and is
// gated behind a signed-in candidate account — no public questions endpoint, so
// fetchAmazonQuestions returns `unsupported`.
const AMAZON_SEARCH_BASE = "https://www.amazon.jobs/en/search.json";
const AMAZON_PAGE_LIMIT = 100;
const AMAZON_MAX_JOBS = 300;

type AmazonJob = {
  id_icims?: string;
  title?: string;
  job_path?: string;
  description?: string;
  description_short?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
  city?: string;
  state?: string;
  country_code?: string;
  normalized_location?: string;
  location?: string;
  posted_date?: string;
  job_category?: string;
  job_family?: string;
  job_schedule_type?: string;
  [k: string]: unknown;
};
type AmazonSearchResponse = {
  error?: unknown;
  hits?: number;
  jobs?: AmazonJob[] | null;
};

function amazonJobToScraped(j: AmazonJob): ScrapedJob | null {
  const title = (j.title ?? "").trim();
  const path = j.job_path ?? "";
  if (!title || !path) return null;
  const location =
    j.normalized_location?.trim() ||
    [j.city, j.state, j.country_code].filter(Boolean).join(", ") ||
    j.location ||
    undefined;
  const department =
    j.job_category?.trim() || j.job_family?.trim() || undefined;
  const parts: string[] = [title];
  const meta = [
    location,
    j.job_schedule_type,
    j.posted_date ? `Posted ${j.posted_date}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  if (meta) parts.push(meta);
  parts.push("");
  const desc = htmlToText(j.description ?? "");
  if (desc) parts.push(desc);
  const basic = htmlToText(j.basic_qualifications ?? "");
  if (basic) parts.push(`\nBasic qualifications:\n${basic}`);
  const pref = htmlToText(j.preferred_qualifications ?? "");
  if (pref) parts.push(`\nPreferred qualifications:\n${pref}`);
  return {
    title,
    sourceUrl: `https://www.amazon.jobs${path}`,
    rawContent: parts.join("\n").trim(),
    location,
    department,
    employmentType: j.job_schedule_type || undefined,
    // raw search row carries city/state/country, posted_date, job_category,
    // business_category, id_icims, etc. Skip the long qual/description blobs +
    // the python-repr'd `locations`/`team` strings (noise).
    attributes: rawAttrs(j, [
      "description_short",
      "basic_qualifications",
      "preferred_qualifications",
      "locations",
      "team",
    ]),
  };
}

async function fetchAllAmazon(inputUrl: string): Promise<ScrapeResult> {
  // Forward any search filters from the pasted careers URL (base_query, country,
  // category, …) minus our paging params, so a scoped board stays scoped.
  let forwarded = "";
  try {
    const u = new URL(inputUrl);
    u.searchParams.delete("offset");
    u.searchParams.delete("result_limit");
    forwarded = u.searchParams.toString();
  } catch {
    /* non-URL input — fall back to an unfiltered search */
  }
  const jobs: ScrapedJob[] = [];
  let total = 0;
  let firstSnippet = "";
  let bytes = 0;
  let offset = 0;
  while (jobs.length < AMAZON_MAX_JOBS) {
    const params = new URLSearchParams(forwarded);
    params.set("result_limit", String(AMAZON_PAGE_LIMIT));
    params.set("offset", String(offset));
    const url = `${AMAZON_SEARCH_BASE}?${params.toString()}`;
    const res = await fetchText(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `amazon list ${res.error}` };
    bytes += res.text.length;
    if (!firstSnippet) firstSnippet = res.text.slice(0, 400);
    let parsed: AmazonSearchResponse;
    try {
      parsed = JSON.parse(res.text) as AmazonSearchResponse;
    } catch {
      return { ok: false, error: `amazon list ${url}: invalid JSON` };
    }
    if (typeof parsed.hits === "number") total = parsed.hits;
    const batch = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    if (batch.length === 0) break;
    for (const j of batch) {
      if (jobs.length >= AMAZON_MAX_JOBS) break;
      const sj = amazonJobToScraped(j);
      if (sj) jobs.push(sj);
    }
    if (batch.length < AMAZON_PAGE_LIMIT) break;
    offset += AMAZON_PAGE_LIMIT;
  }
  const truncated = total > jobs.length;
  return {
    ok: true,
    data: {
      companyName: "Amazon",
      jobs,
      diagnostics: {
        provider: "amazon",
        fetchedUrl: `${AMAZON_SEARCH_BASE}${forwarded ? `?${forwarded}` : ""}`,
        pageLength: bytes,
        pageSnippet: firstSnippet,
        ...(truncated ? { truncatedAt: jobs.length } : {}),
      },
    },
  };
}

export const amazon: AtsProviderModule = {
  provider: "amazon",
  hostFragments: ["amazon.jobs"],
  // account.amazon.jobs apply flow requires a signed-in candidate — no public
  // questions endpoint, so questions stay unsupported (the router returns
  // {status:"unsupported"} and the walkthrough asks the user to fill the form).
  supportsQuestions: false,
  detect(url) {
    if (!AMAZON_RE.test(url)) return null;
    return {
      provider: "amazon",
      fetchedUrl: `${AMAZON_SEARCH_BASE}?result_limit=${AMAZON_PAGE_LIMIT}&offset=0`,
      fetchAll: () => fetchAllAmazon(url),
    };
  },
};
