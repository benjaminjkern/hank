import { htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type { ScrapeResult, ScrapedJob } from "../../types";

// iCIMS career-site (Jibe) JSON API. Lives on a branded custom domain
// (careers.amd.com/api/jobs), so detection is by the exact `/api/jobs` path,
// not the host. Specific enough not to collide with other providers' /api/*
// endpoints (Eightfold is /api/apply/v2/jobs). The canonical board URL we store
// is `{origin}/api/jobs`; resolveBoardFromCareersPage discovers it from a careers page.
const ICIMS_API_RE = /^https?:\/\/[^/?#]+\/api\/jobs(?:[?#/]|$)/i;
// -- iCIMS (career-site "Jibe" JSON API) ----------------------------------
//
// iCIMS is one of the largest enterprise ATSes. Its modern career-site product
// (built on Jibe, which iCIMS acquired) renders an AngularJS SPA on a BRANDED
// CUSTOM DOMAIN (careers.amd.com, careers.icims.com) — there is no shared
// `*.icims.com` host to regex, and the classic `careers-{co}.icims.com` hosted
// board serves only the SPA shell (it does NOT answer the API). But every Jibe
// career site exposes a clean, unauthenticated JSON API at:
//   GET {careers-origin}/api/jobs?page=N&limit=M
//     → { jobs: [{ data: {...} }], totalCount, count, ... }
// The per-job `data` carries the FULL prose (description / qualifications /
// responsibilities, all HTML) bundled in the list — so, like Greenhouse, no
// per-job detail fetch is needed. We page until MAX_JOBS or the last page.
//
// Detection: because the API lives on a custom domain, detectAts can't host-
// match it. The canonical board URL we store is `{origin}/api/jobs` and
// ICIMS_API_RE recognizes exactly that path (specific enough not to collide
// with other providers' `/api/...` endpoints). Discovery from a careers page is
// the job of resolveBoardFromCareersPage, which test_scrape calls on a detect miss.
//
// Application questions: the apply flow redirects to a login-gated
// `careers-{co}.icims.com/jobs/{id}/login` page (the per-job `apply_url`), so
// there is no public questions endpoint — fetchIcimsQuestions returns
// `unsupported` (iCIMS is deliberately absent from QUESTIONS_CAPABLE_PROVIDERS).
//
// The older standalone `careers-{co}.icims.com/jobs/search` AngularJS boards
// (companies on iCIMS WITHOUT the Jibe career-site front end) are NOT covered
// here — they'd need a headless render. Those remain a deferred capability.
const ICIMS_PAGE_LIMIT = 100;
const ICIMS_MAX_JOBS = 300;

type IcimsJobData = {
  slug?: string;
  req_id?: string;
  title?: string;
  full_location?: string;
  short_location?: string;
  location_name?: string;
  city?: string;
  state?: string;
  country?: string;
  multipleLocations?: boolean;
  department?: string;
  category?: string[] | string;
  employment_type?: string;
  salary_min_value?: number;
  salary_max_value?: number;
  salary_value?: number;
  description?: string;
  qualifications?: string;
  responsibilities?: string;
  apply_url?: string;
  client_code?: string;
  hiring_organization?: string;
  ats_code?: string;
  [k: string]: unknown;
};
type IcimsListResponse = {
  jobs?: Array<{ data?: IcimsJobData }> | null;
  totalCount?: number;
  count?: number;
};

// Provider employment_type tokens (FULL_TIME / PART_TIME / CONTRACT / INTERN)
// → human label for the cleaned column. Unknown values pass through as-is.
function icimsEmploymentType(raw?: string): string | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  const map: Record<string, string> = {
    FULL_TIME: "Full-time",
    PART_TIME: "Part-time",
    CONTRACT: "Contract",
    CONTRACTOR: "Contract",
    TEMPORARY: "Temporary",
    INTERN: "Internship",
    INTERNSHIP: "Internship",
  };
  return map[v.toUpperCase()] ?? v;
}

function icimsCategoryLabel(category?: string[] | string): string | undefined {
  if (!category) return undefined;
  const arr = Array.isArray(category) ? category : [category];
  const cleaned = arr.map((c) => String(c).trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(", ") : undefined;
}

function icimsCompensation(d: IcimsJobData): string | undefined {
  const min = typeof d.salary_min_value === "number" ? d.salary_min_value : 0;
  const max = typeof d.salary_max_value === "number" ? d.salary_max_value : 0;
  const single = typeof d.salary_value === "number" ? d.salary_value : 0;
  const fmt = (n: number) => `$${n.toLocaleString("en-US")}`;
  if (min > 0 && max > 0)
    return min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
  if (single > 0) return fmt(single);
  if (min > 0) return `${fmt(min)}+`;
  if (max > 0) return `Up to ${fmt(max)}`;
  return undefined;
}

function icimsJobToScraped(origin: string, d: IcimsJobData): ScrapedJob | null {
  const title = (d.title ?? "").trim();
  const slug = (d.slug ?? d.req_id ?? "").toString().trim();
  if (!title || !slug) return null;

  const location =
    d.full_location?.trim() ||
    d.short_location?.trim() ||
    [d.city, d.state, d.country].filter(Boolean).join(", ") ||
    undefined;
  const department =
    (d.department ?? "").trim() || icimsCategoryLabel(d.category);
  const employmentType = icimsEmploymentType(d.employment_type);
  const compensation = icimsCompensation(d);

  const parts: string[] = [title];
  const meta = [
    d.multipleLocations
      ? `${location ?? "Multiple locations"} (+ more)`
      : location,
    employmentType,
    compensation,
  ]
    .filter(Boolean)
    .join(" • ");
  if (meta) parts.push(meta);
  parts.push("");
  const desc = htmlToText(d.description ?? "");
  if (desc) parts.push(desc);
  const resp = htmlToText(d.responsibilities ?? "");
  if (resp) parts.push(`\nResponsibilities:\n${resp}`);
  const qual = htmlToText(d.qualifications ?? "");
  if (qual) parts.push(`\nQualifications:\n${qual}`);

  return {
    title,
    // Public posting page (human-viewable). The `apply_url` is a login wall, so
    // we link the SPA route instead — `/careers-home/jobs/{slug}` is the Jibe
    // canonical path (verified on careers.amd.com / careers.icims.com).
    sourceUrl: `${origin}/careers-home/jobs/${slug}`,
    rawContent: parts.join("\n").trim(),
    location,
    department,
    employmentType,
    compensation,
    // Raw Jibe row minus the long HTML blobs (kept in rawContent above).
    attributes: rawAttrs(d, [
      "description",
      "qualifications",
      "responsibilities",
    ]),
  };
}

async function fetchAllIcims(origin: string): Promise<ScrapeResult> {
  const jobs: ScrapedJob[] = [];
  let total = 0;
  let companyName = "";
  let firstSnippet = "";
  let bytes = 0;
  let page = 1;
  while (jobs.length < ICIMS_MAX_JOBS) {
    const url = `${origin}/api/jobs?page=${page}&limit=${ICIMS_PAGE_LIMIT}`;
    const res = await fetchText(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `icims list ${res.error}` };
    bytes += res.text.length;
    if (!firstSnippet) firstSnippet = res.text.slice(0, 400);
    let parsed: IcimsListResponse;
    try {
      parsed = JSON.parse(res.text) as IcimsListResponse;
    } catch {
      return {
        ok: false,
        error: `icims list ${url}: invalid JSON (not a Jibe career-site API)`,
      };
    }
    const batch = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    if (typeof parsed.totalCount === "number") total = parsed.totalCount;
    else if (typeof parsed.count === "number") total = parsed.count;
    if (batch.length === 0) break;
    for (const entry of batch) {
      if (jobs.length >= ICIMS_MAX_JOBS) break;
      const d = entry?.data;
      if (!d) continue;
      if (!companyName) {
        companyName =
          (d.hiring_organization ?? "").trim() ||
          (d.client_code ? titleCaseSlug(d.client_code) : "");
      }
      const sj = icimsJobToScraped(origin, d);
      if (sj) jobs.push(sj);
    }
    if (batch.length < ICIMS_PAGE_LIMIT) break;
    page += 1;
  }

  if (!companyName) {
    // Fall back to the careers host (careers.amd.com → "Amd") when the rows
    // carried no org/client name.
    try {
      companyName = titleCaseSlug(
        new URL(origin).hostname.split(".")[1] ?? "company",
      );
    } catch {
      companyName = "Company";
    }
  }

  const truncated = total > jobs.length;
  return {
    ok: true,
    data: {
      companyName,
      jobs,
      diagnostics: {
        provider: "icims",
        fetchedUrl: `${origin}/api/jobs`,
        pageLength: bytes,
        pageSnippet: firstSnippet,
        ...(truncated ? { truncatedAt: jobs.length } : {}),
      },
    },
  };
}

export const icims: AtsProviderModule = {
  provider: "icims",
  detect(url) {
    if (!ICIMS_API_RE.test(url)) return null;
    // Canonical iCIMS (Jibe) board URL — `{origin}/api/jobs`. The hunter stores
    // this form via resolveBoardFromCareersPage; re-scrapes route straight back here.
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return null;
    }
    return {
      provider: "icims",
      fetchedUrl: `${origin}/api/jobs`,
      fetchAll: () => fetchAllIcims(origin),
    };
  },
};
