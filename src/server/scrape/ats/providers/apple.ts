import { htmlToText } from "@/utils/html";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type { ScrapeResult, ScrapedJob } from "../../types";

const APPLE_RE = /^https?:\/\/jobs\.apple\.com\//i;
// -- Apple (jobs.apple.com) ----------------------------------------------
//
// Single-tenant React-Router SSR site. Both the search page and each
// /details/{positionId}/{slug} page embed the job data in
// `window.__staticRouterHydrationData = JSON.parse("…")` — no API call, no
// Playwright. The search page's loaderData.search.searchResults is the (paged)
// list; the detail page's loaderData.jobDetails.jobsData has the full
// description + qualifications.
//
// Questions: the apply flow requires an Apple ID sign-in — no public form
// endpoint, so questions are unsupported.
const APPLE_PAGE_SIZE = 20;
const APPLE_MAX_JOBS = 100;
const APPLE_DETAIL_CONCURRENCY = 5;

// Extract `window.__staticRouterHydrationData = JSON.parse("<js-string>")` from a
// React-Router SSR page. The argument is a JS double-quoted string literal whose
// contents are escaped JSON: JSON.parse the literal to unescape, then JSON.parse
// the result. Returns null if absent/unparseable.
function extractStaticRouterData(html: string): unknown {
  const m = html.match(
    /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\)/,
  );
  if (!m) return null;
  try {
    return JSON.parse(JSON.parse(`"${m[1]}"`) as string);
  } catch {
    return null;
  }
}

type AppleLocation = { name?: string; countryName?: string };
type AppleJob = {
  positionId?: number | string;
  reqId?: string;
  postingTitle?: string;
  transformedPostingTitle?: string;
  jobSummary?: string;
  description?: string;
  keyQualifications?: string | string[] | null;
  minimumQualifications?: string | null;
  teamNames?: string[];
  locations?: AppleLocation[];
  homeOffice?: boolean;
  postDateInGMT?: string;
  [k: string]: unknown;
};

function appleLocation(job: AppleJob): string | undefined {
  const names = (job.locations ?? [])
    .map((l) => l.name?.trim())
    .filter((n): n is string => !!n);
  const base = Array.from(new Set(names)).join(" • ");
  const suffix = job.homeOffice ? "Remote" : null;
  const out = [base || null, suffix].filter(Boolean).join(" • ");
  return out || undefined;
}

function appleQualText(v: string | string[] | null | undefined): string {
  if (!v) return "";
  return htmlToText(Array.isArray(v) ? v.join("\n") : v);
}

function appleJobToScraped(locale: string, job: AppleJob): ScrapedJob | null {
  const title = (job.postingTitle ?? "").trim();
  const pid = job.positionId != null ? String(job.positionId) : "";
  if (!title || !pid) return null;
  const slug = job.transformedPostingTitle || "job";
  const location = appleLocation(job);
  const department = job.teamNames?.filter(Boolean).join(", ") || undefined;
  const parts: string[] = [title];
  const meta = [location, department].filter(Boolean).join(" • ");
  if (meta) parts.push(meta);
  const sections: Array<[string, string]> = [
    ["", htmlToText(job.jobSummary ?? "")],
    ["", htmlToText(job.description ?? "")],
    ["Key Qualifications", appleQualText(job.keyQualifications)],
    ["Minimum Qualifications", appleQualText(job.minimumQualifications)],
  ];
  for (const [label, text] of sections) {
    if (!text) continue;
    parts.push("");
    parts.push(label ? `${label}:\n${text}` : text);
  }
  return {
    title,
    sourceUrl: `https://jobs.apple.com/${locale}/details/${pid}/${slug}`,
    rawContent: parts.join("\n").trim(),
    location,
    department,
    attributes: rawAttrs(job, [
      "jobSummary",
      "description",
      "keyQualifications",
      "minimumQualifications",
      "localizations",
      "localeInfo",
      "localeLanguages",
      "postingPostLocationData",
    ]),
  };
}

async function fetchAppleDetail(
  locale: string,
  summary: AppleJob,
): Promise<ScrapedJob | null> {
  const pid = summary.positionId != null ? String(summary.positionId) : "";
  const slug = summary.transformedPostingTitle || "job";
  if (!pid) return null;
  const res = await fetchText(
    `https://jobs.apple.com/${locale}/details/${pid}/${slug}`,
    {
      headers: { Accept: "text/html" },
    },
  );
  if (res.ok) {
    const data = extractStaticRouterData(res.text) as {
      loaderData?: { jobDetails?: { jobsData?: AppleJob } };
    } | null;
    const full = data?.loaderData?.jobDetails?.jobsData;
    if (full) return appleJobToScraped(locale, { ...summary, ...full });
  }
  // Fall back to the search-list summary (still carries jobSummary).
  return appleJobToScraped(locale, summary);
}

async function fetchAllApple(inputUrl: string): Promise<ScrapeResult> {
  const localeMatch = inputUrl.match(
    /jobs\.apple\.com\/([a-z]{2}-[a-z]{2})\//i,
  );
  const locale = localeMatch ? localeMatch[1].toLowerCase() : "en-us";
  // Forward any search filters from the pasted URL minus paging.
  let forwarded = "";
  try {
    const u = new URL(inputUrl);
    u.searchParams.delete("page");
    forwarded = u.searchParams.toString();
  } catch {
    /* ignore */
  }
  if (!forwarded) forwarded = "sort=newest";

  const summaries: AppleJob[] = [];
  let bytes = 0;
  let snippet = "";
  let page = 1;
  while (summaries.length < APPLE_MAX_JOBS) {
    const url = `https://jobs.apple.com/${locale}/search?${forwarded}&page=${page}`;
    const res = await fetchText(url, { headers: { Accept: "text/html" } });
    if (!res.ok) return { ok: false, error: `apple search ${res.error}` };
    bytes += res.text.length;
    if (!snippet) snippet = res.text.slice(0, 400);
    const data = extractStaticRouterData(res.text) as {
      loaderData?: { search?: { searchResults?: AppleJob[] } };
    } | null;
    const batch = data?.loaderData?.search?.searchResults ?? [];
    if (batch.length === 0) break;
    for (const j of batch) {
      if (summaries.length >= APPLE_MAX_JOBS) break;
      summaries.push(j);
    }
    if (batch.length < APPLE_PAGE_SIZE) break;
    page += 1;
  }

  const jobs: ScrapedJob[] = [];
  for (let i = 0; i < summaries.length; i += APPLE_DETAIL_CONCURRENCY) {
    const chunk = summaries.slice(i, i + APPLE_DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((s) => fetchAppleDetail(locale, s)),
    );
    for (const s of settled)
      if (s.status === "fulfilled" && s.value) jobs.push(s.value);
  }

  return {
    ok: true,
    data: {
      companyName: "Apple",
      jobs,
      diagnostics: {
        provider: "apple",
        fetchedUrl: `https://jobs.apple.com/${locale}/search?${forwarded}`,
        pageLength: bytes,
        pageSnippet: snippet,
        ...(summaries.length >= APPLE_MAX_JOBS
          ? { truncatedAt: jobs.length }
          : {}),
      },
    },
  };
}

export const apple: AtsProviderModule = {
  provider: "apple",
  hostFragments: ["jobs.apple.com"],
  // The apply flow requires an Apple ID sign-in — no public form endpoint, so
  // questions are unsupported.
  supportsQuestions: false,
  detect(url) {
    if (!APPLE_RE.test(url)) return null;
    return {
      provider: "apple",
      fetchedUrl: "https://jobs.apple.com/en-us/search",
      fetchAll: () => fetchAllApple(url),
    };
  },
};
