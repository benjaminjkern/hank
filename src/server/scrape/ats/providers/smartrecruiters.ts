import { htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type { ScrapeResult, ScrapedJob } from "../../types";

const SMARTRECRUITERS_RE =
  /^https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([^/?#]+)/i;
const SMARTRECRUITERS_API_RE =
  /^https?:\/\/api\.smartrecruiters\.com\/v1\/companies\/([^/?#]+)/i;
// -- SmartRecruiters ------------------------------------------------------
//
// Multi-tenant. Career sites live at jobs.smartrecruiters.com/{companyId} (or
// careers.smartrecruiters.com/{companyId}); the documented, unauthenticated
// Posting API is:
//   list:   GET api.smartrecruiters.com/v1/companies/{companyId}/postings?limit=100&offset=N
//   detail: GET api.smartrecruiters.com/v1/companies/{companyId}/postings/{id}
// The list rows carry every structured field (location, department, function,
// typeOfEmployment, experienceLevel, customField) EXCEPT the body — the prose
// lives only in the detail response's jobAd.sections {companyDescription,
// jobDescription, qualifications, additionalInformation}. So we page the list
// then fan-out detail fetches (capped + concurrency-limited, Workday-style).
//
// Application questions: the screening-questions endpoint
// (GET /postings/{uuid}/configuration on the Application API) is auth-gated
// (401 without an API key), so fetchSmartRecruitersQuestions returns
// `unsupported`.
const SMARTRECRUITERS_PAGE_LIMIT = 100;
const SMARTRECRUITERS_MAX_DETAIL_JOBS = 100;
const SMARTRECRUITERS_DETAIL_CONCURRENCY = 5;

type SrLabel = { id?: string; label?: string };
type SrLocation = {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
  fullLocation?: string;
};
type SrSection = { title?: string; text?: string };
type SrPosting = {
  id?: string;
  uuid?: string;
  name?: string;
  refNumber?: string;
  company?: { identifier?: string; name?: string };
  releasedDate?: string;
  location?: SrLocation;
  industry?: SrLabel;
  department?: SrLabel;
  function?: SrLabel;
  typeOfEmployment?: SrLabel;
  experienceLevel?: SrLabel;
  language?: { code?: string; label?: string };
  customField?: Array<{
    fieldId?: string;
    fieldLabel?: string;
    valueId?: string;
    valueLabel?: string;
  }>;
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: {
    sections?: {
      companyDescription?: SrSection;
      jobDescription?: SrSection;
      qualifications?: SrSection;
      additionalInformation?: SrSection;
    };
  };
};
type SrListResponse = { totalFound?: number; content?: SrPosting[] };

function smartRecruitersLocation(loc?: SrLocation): string | undefined {
  if (!loc) return undefined;
  const base =
    loc.fullLocation?.trim() ||
    [loc.city, loc.region, loc.country?.toUpperCase()]
      .filter(Boolean)
      .join(", ");
  const suffix = loc.remote ? "Remote" : loc.hybrid ? "Hybrid" : null;
  const out = [base || null, suffix].filter(Boolean).join(" • ");
  return out || undefined;
}

// Empty section bodies mean the company isn't publishing that prose, NOT a
// parser bug — some tenants (e.g. Visa) serve a boilerplate `defaultJobAd`
// placeholder that comes back blank here. Verify against the live API before
// treating a null body as a regression.
function smartRecruitersBody(detail: SrPosting): string {
  const s = detail.jobAd?.sections;
  if (!s) return "";
  const parts: string[] = [];
  for (const sec of [
    s.companyDescription,
    s.jobDescription,
    s.qualifications,
    s.additionalInformation,
  ]) {
    const text = htmlToText(sec?.text ?? "").trim();
    if (!text) continue;
    const heading = sec?.title?.trim();
    parts.push(heading ? `${heading}:\n${text}` : text);
  }
  return parts.join("\n\n").trim();
}

async function fetchSmartRecruitersDetail(
  slug: string,
  posting: SrPosting,
): Promise<ScrapedJob | null> {
  const id = posting.id;
  const title = (posting.name ?? "").trim();
  if (!id || !title) return null;
  const res = await fetchText(
    `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`,
    { headers: { Accept: "application/json" } },
  );
  // Merge: detail carries the body + postingUrl; the list row already has the
  // structured fields. Fall back to the list row if detail fetch fails.
  let detail: SrPosting = posting;
  if (res.ok) {
    try {
      detail = { ...posting, ...(JSON.parse(res.text) as SrPosting) };
    } catch {
      /* keep list-row fields */
    }
  }
  const sourceUrl =
    detail.postingUrl || `https://jobs.smartrecruiters.com/${slug}/${id}`;
  const location = smartRecruitersLocation(detail.location);
  const body = smartRecruitersBody(detail);
  const parts: string[] = [title];
  const meta = [
    location,
    detail.typeOfEmployment?.label,
    detail.experienceLevel?.label,
  ]
    .filter(Boolean)
    .join(" • ");
  if (meta) parts.push(meta);
  if (body) {
    parts.push("");
    parts.push(body);
  }
  return {
    title,
    sourceUrl,
    rawContent: parts.join("\n").trim(),
    location,
    department: detail.department?.label || undefined,
    employmentType: detail.typeOfEmployment?.label || undefined,
    // detail carries refNumber, releasedDate, function, experienceLevel,
    // industry, language, customField, applyUrl, etc. Skip the body bag (jobAd),
    // the redundant company object, recruiter PII (creator), and the signed
    // referralUrl (no scan value, just bloats the LLM-bound bag).
    attributes: rawAttrs(detail, [
      "jobAd",
      "company",
      "creator",
      "referralUrl",
    ]),
  };
}

async function fetchAllSmartRecruiters(slug: string): Promise<ScrapeResult> {
  const postings: SrPosting[] = [];
  let total = 0;
  let firstSnippet = "";
  let bytes = 0;
  let offset = 0;
  while (postings.length < SMARTRECRUITERS_MAX_DETAIL_JOBS) {
    const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SMARTRECRUITERS_PAGE_LIMIT}&offset=${offset}`;
    const res = await fetchText(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok)
      return { ok: false, error: `smartrecruiters list ${res.error}` };
    bytes += res.text.length;
    if (!firstSnippet) firstSnippet = res.text.slice(0, 400);
    let parsed: SrListResponse;
    try {
      parsed = JSON.parse(res.text) as SrListResponse;
    } catch {
      return { ok: false, error: `smartrecruiters list ${url}: invalid JSON` };
    }
    if (typeof parsed.totalFound === "number") total = parsed.totalFound;
    const batch = Array.isArray(parsed.content) ? parsed.content : [];
    if (batch.length === 0) break;
    for (const p of batch) {
      if (postings.length >= SMARTRECRUITERS_MAX_DETAIL_JOBS) break;
      postings.push(p);
    }
    if (batch.length < SMARTRECRUITERS_PAGE_LIMIT) break;
    offset += SMARTRECRUITERS_PAGE_LIMIT;
  }

  const jobs: ScrapedJob[] = [];
  for (
    let i = 0;
    i < postings.length;
    i += SMARTRECRUITERS_DETAIL_CONCURRENCY
  ) {
    const chunk = postings.slice(i, i + SMARTRECRUITERS_DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((p) => fetchSmartRecruitersDetail(slug, p)),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) jobs.push(s.value);
    }
  }

  const companyName =
    postings.find((p) => p.company?.name)?.company?.name?.trim() ||
    titleCaseSlug(slug);
  const truncated = total > jobs.length;
  return {
    ok: true,
    data: {
      companyName,
      jobs,
      diagnostics: {
        provider: "smartrecruiters",
        fetchedUrl: `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
        pageLength: bytes,
        pageSnippet: firstSnippet,
        ...(truncated ? { truncatedAt: jobs.length } : {}),
      },
    },
  };
}

export const smartrecruiters: AtsProviderModule = {
  provider: "smartrecruiters",
  hostFragments: ["smartrecruiters.com"],
  // The screening-questions config (Application API /postings/{uuid}/configuration)
  // is auth-gated (401 without an API key). No unauthenticated path today.
  supportsQuestions: false,
  detect(url) {
    const m =
      url.match(SMARTRECRUITERS_RE) ?? url.match(SMARTRECRUITERS_API_RE);
    if (!m) return null;
    const slug = m[1];
    return {
      provider: "smartrecruiters",
      fetchedUrl: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SMARTRECRUITERS_PAGE_LIMIT}&offset=0`,
      fetchAll: () => fetchAllSmartRecruiters(slug),
    };
  },
};
