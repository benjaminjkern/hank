import { decodeEntities, htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
  ScrapeResult,
  ScrapedJob,
} from "../../types";

const JAZZHR_RE = /^https?:\/\/(?!www\.)([a-z0-9-]+)\.applytojob\.com/i;
// A JazzHR job/apply URL → capture the {code}. Handles both the public
// /apply/{code}/{title} shape and the board's /apply/jobs/details/{code} shape.
const JAZZHR_JOB_RE =
  /^https?:\/\/(?:[a-z0-9-]+)\.applytojob\.com\/apply\/(?:jobs\/details\/)?([a-zA-Z0-9]+)/i;
// -- JazzHR (applytojob.com) ----------------------------------------------
//
// Multi-tenant server-rendered boards at {slug}.applytojob.com. All plain fetch
// (a browser-shaped UA avoids the occasional bot 403):
//   list:      GET {slug}.applytojob.com/apply/jobs/  → /apply/jobs/details/{code} links
//   detail:    GET {slug}.applytojob.com/apply/jobs/details/{code} → schema.org JobPosting (ld+json)
//   questions: GET {slug}.applytojob.com/apply/get/questions/{code} → token-free Indeed-Apply JSON
//              (screenerQuestions.questions[]; the resumator-* ids are built-in PII, skipped)
const JAZZHR_MAX_DETAIL_JOBS = 300;
const JAZZHR_DETAIL_CONCURRENCY = 5;
const JAZZHR_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type LdAddress = {
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string;
};
type LdJobPosting = {
  "@type"?: string;
  url?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string | string[];
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: LdAddress } | Array<{ address?: LdAddress }>;
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number; unitText?: string };
  };
  [k: string]: unknown;
};

// Pull the first schema.org JobPosting out of a page's ld+json <script> blocks.
function extractLdJobPosting(html: string): LdJobPosting | null {
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const d of arr) {
        if (d && typeof d === "object" && d["@type"] === "JobPosting") {
          return d as LdJobPosting;
        }
      }
    } catch {
      /* skip non-JSON ld+json */
    }
  }
  return null;
}

function ldEmploymentType(t?: string | string[]): string | undefined {
  const raw = Array.isArray(t) ? t[0] : t;
  if (!raw) return undefined;
  const s = raw.replace(/_/g, "-"); // FULL_TIME → FULL-TIME
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); // → Full-time
}

function ldLocation(jp: LdJobPosting): string | undefined {
  const locs = Array.isArray(jp.jobLocation)
    ? jp.jobLocation
    : jp.jobLocation
      ? [jp.jobLocation]
      : [];
  const labels = locs
    .map((l) => {
      const a = l.address;
      if (!a) return null;
      return [a.addressLocality, a.addressRegion, a.addressCountry]
        .filter(Boolean)
        .join(", ");
    })
    .filter((s): s is string => !!s);
  const out = Array.from(new Set(labels)).join(" • ");
  return out || undefined;
}

function ldSalary(jp: LdJobPosting): string | undefined {
  const v = jp.baseSalary?.value;
  if (!v || (v.minValue == null && v.maxValue == null)) return undefined;
  const cur = jp.baseSalary?.currency || "USD";
  const fmt = (n?: number) =>
    typeof n === "number"
      ? n.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : "?";
  const range =
    v.minValue != null && v.maxValue != null
      ? `${fmt(v.minValue)}–${fmt(v.maxValue)}`
      : fmt(v.minValue ?? v.maxValue);
  return [cur, range, v.unitText?.toLowerCase()].filter(Boolean).join(" ");
}

async function fetchJazzHRDetail(
  slug: string,
  code: string,
): Promise<{ scraped: ScrapedJob; orgName?: string } | null> {
  const res = await fetchText(
    `https://${slug}.applytojob.com/apply/jobs/details/${code}`,
    {
      headers: { Accept: "text/html", "User-Agent": JAZZHR_UA },
    },
  );
  if (!res.ok) return null;
  const jp = extractLdJobPosting(res.text);
  if (!jp?.title) return null;
  const title = jp.title.trim();
  const location = ldLocation(jp);
  const compensation = ldSalary(jp);
  const employmentType = ldEmploymentType(jp.employmentType);
  const body = htmlToText(jp.description ?? "");
  const parts: string[] = [title];
  const meta = [location, employmentType, compensation]
    .filter(Boolean)
    .join(" • ");
  if (meta) parts.push(meta);
  if (body) {
    parts.push("");
    parts.push(body);
  }
  return {
    scraped: {
      title,
      sourceUrl:
        jp.url || `https://${slug}.applytojob.com/apply/jobs/details/${code}`,
      rawContent: parts.join("\n").trim(),
      location,
      employmentType,
      compensation,
      // ld+json carries datePosted, validThrough, hiringOrganization, jobLocation,
      // experienceRequirements, uniqueJobCode, baseSalary. Skip the description blob.
      attributes: rawAttrs(jp, ["description"]),
    },
    orgName: jp.hiringOrganization?.name?.trim() || undefined,
  };
}

async function fetchAllJazzHR(slug: string): Promise<ScrapeResult> {
  const listUrl = `https://${slug}.applytojob.com/apply/jobs/`;
  const res = await fetchText(listUrl, {
    headers: { Accept: "text/html", "User-Agent": JAZZHR_UA },
  });
  if (!res.ok) return { ok: false, error: `jazzhr list ${res.error}` };
  // The list page is complete in one response (no pagination markers exist on
  // it), so `allCodes.length` is the true board size — which makes both the cap
  // and a failed detail fetch visible below.
  const allCodes = Array.from(
    new Set(
      Array.from(
        res.text.matchAll(/\/apply\/jobs\/details\/([a-zA-Z0-9]+)/g),
      ).map((mm) => mm[1]),
    ),
  );
  const codes = allCodes.slice(0, JAZZHR_MAX_DETAIL_JOBS);
  const jobs: ScrapedJob[] = [];
  let orgName: string | undefined;
  for (let i = 0; i < codes.length; i += JAZZHR_DETAIL_CONCURRENCY) {
    const chunk = codes.slice(i, i + JAZZHR_DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((c) => fetchJazzHRDetail(slug, c)),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) {
        jobs.push(s.value.scraped);
        if (!orgName && s.value.orgName) orgName = s.value.orgName;
      }
    }
  }
  return {
    ok: true,
    data: {
      companyName: orgName || titleCaseSlug(slug),
      jobs,
      diagnostics: {
        provider: "jazzhr",
        fetchedUrl: listUrl,
        pageLength: res.text.length,
        pageSnippet: res.text.slice(0, 400),
        ...(allCodes.length > jobs.length ? { truncatedAt: jobs.length } : {}),
      },
    },
  };
}

type JazzHRScreenerQuestion = {
  id?: string;
  type?: string;
  question?: string;
  required?: boolean;
};
type JazzHRQuestionsResponse = {
  screenerQuestions?: { questions?: JazzHRScreenerQuestion[] };
};

async function fetchJazzHRQuestions(
  jobSourceUrl: string,
): Promise<ApplicationQuestionsEnvelope> {
  const hostM = jobSourceUrl.match(JAZZHR_RE);
  const codeM = jobSourceUrl.match(JAZZHR_JOB_RE);
  if (!hostM || !codeM) {
    return {
      status: "error",
      error: `not a recognized jazzhr job url: ${jobSourceUrl}`,
      fetchedAt: new Date().toISOString(),
    };
  }
  const slug = hostM[1];
  const code = codeM[1];
  const res = await fetchText(
    `https://${slug}.applytojob.com/apply/get/questions/${code}`,
    {
      headers: { Accept: "application/json", "User-Agent": JAZZHR_UA },
    },
  );
  if (!res.ok) {
    return {
      status: "error",
      error: res.error,
      fetchedAt: new Date().toISOString(),
    };
  }
  let data: JazzHRQuestionsResponse;
  try {
    data = JSON.parse(res.text) as JazzHRQuestionsResponse;
  } catch {
    return {
      status: "error",
      error: "invalid JSON in jazzhr questions",
      fetchedAt: new Date().toISOString(),
    };
  }
  const questions: ApplicationQuestion[] = [];
  let coverLetter = false;
  for (const q of data.screenerQuestions?.questions ?? []) {
    const id = q.id ?? "";
    // resumator-* ids are JazzHR's built-in standard fields (address/city/state/
    // postal/resume/etc.), not recruiter questions — skip them.
    if (id.startsWith("resumator-")) continue;
    const text = decodeEntities(q.question ?? "")
      .trim()
      .replace(/\*+$/, "")
      .trim();
    if (!text) continue;
    if (/\bcover\s*letter\b/i.test(text)) coverLetter = true;
    const item: ApplicationQuestion = { question: text };
    if (q.required) item.required = true;
    if (q.type) item.type = q.type;
    questions.push(item);
  }
  const fetchedAt = new Date().toISOString();
  if (questions.length === 0)
    return { status: "empty", coverLetter, fetchedAt };
  return { status: "ok", questions, coverLetter, fetchedAt };
}

export const jazzhr: AtsProviderModule = {
  provider: "jazzhr",
  hostFragments: ["applytojob.com"],
  supportsQuestions: true,
  detect(url) {
    const m = url.match(JAZZHR_RE);
    if (!m) return null;
    const slug = m[1];
    return {
      provider: "jazzhr",
      fetchedUrl: `https://${slug}.applytojob.com/apply/jobs/`,
      fetchAll: () => fetchAllJazzHR(slug),
    };
  },
  matchesQuestions(url) {
    return JAZZHR_RE.test(url);
  },
  fetchQuestions(url) {
    return fetchJazzHRQuestions(url);
  },
};
