import { htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
  ScrapeResult,
  ScrapedJob,
} from "../../types";

const WORKDAY_RE =
  /^https?:\/\/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/i;
// Pull the canonical Workday board URL out of a fetched careers page's HTML.
//
// Workday boards live at {tenant}.{shard}.myworkdayjobs.com/{site}, where the
// shard (wd1..wd108+) is an unguessable data-center marker and the site is a
// tenant-chosen slug. Enterprises almost never expose the raw board — they wrap
// it behind a branded careers domain (lifeatexpediagroup.com, careers.{co}.com)
// that embeds the real board/API URL in its HTML. The basic-info hunter can't
// slug-guess these (Expedia is `expedia.wd108/search` — no reasonable guess
// hits wd108), so the only reliable discovery path is fetch-the-careers-page +
// extract. This scans the HTML for the first myworkdayjobs URL (either a board
// URL `/{locale?}/{site}/...` or the SPA's `wday/cxs/{tenant}/{site}/...` API
// URL) and returns the canonical board URL `{origin}/{site}`, or null.
const WORKDAY_HOST_IN_HTML_RE =
  /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com(\/[^\s"'<>\\)]*)?/gi;

function workdaySiteFromPath(path: string): string | null {
  // Drop any query/hash so a board URL like `/{site}?foo` yields a clean site.
  const segs = path
    .replace(/[?#].*$/, "")
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean);
  if (segs.length === 0) return null;
  // SPA API form: wday/cxs/{tenant}/{site}/jobs — the site is the 4th segment.
  if (segs[0] === "wday" && segs[1] === "cxs" && segs[3]) return segs[3];
  // Board form: an optional locale segment (en-US) precedes the site slug.
  let i = 0;
  if (/^[a-z]{2}-[A-Z]{2}$/.test(segs[i])) i++;
  const site = segs[i];
  // Bare host (no site) or a deep-link into the SPA wrapper isn't a board root.
  if (!site || site === "wday") return null;
  return site;
}

export function extractWorkdayBoardUrlFromHtml(html: string): string | null {
  for (const m of html.matchAll(WORKDAY_HOST_IN_HTML_RE)) {
    const tenant = m[1].toLowerCase();
    const shard = m[2].toLowerCase();
    const site = workdaySiteFromPath(m[3] ?? "");
    if (site) return `https://${tenant}.${shard}.myworkdayjobs.com/${site}`;
  }
  return null;
}
// -- Workday --------------------------------------------------------------
//
// Workday's hosted boards live at {tenant}.{shard}.myworkdayjobs.com/{site}
// (shard is wd1..wd105+, a load-balancer marker that varies per board). The
// SPA is backed by the unauthenticated `/wday/cxs/...` endpoints:
//
//   POST /wday/cxs/{tenant}/{site}/jobs       — paged list
//   GET  /wday/cxs/{tenant}/{site}{externalPath}  — per-job detail
//   GET  /wday/cxs/{tenant}/questionnaire/{questionnaireId}  — apply questions
//
// Unlike Greenhouse/Lever/Ashby, the list response is summaries only — we
// fan-out per-job detail fetches to fill in rawContent. To avoid wedging on
// the long tail (Salesforce/NVIDIA each carry 1000+ openings) we cap at
// WORKDAY_MAX_DETAIL_JOBS and emit a `truncatedAt` diagnostic so the agent
// knows the result is partial.

const WORKDAY_PAGE_LIMIT = 20;
const WORKDAY_MAX_DETAIL_JOBS = 300;
const WORKDAY_DETAIL_CONCURRENCY = 5;

const WORKDAY_JOB_RE =
  /^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)(\/job\/[^?#]+)/i;

type WorkdayListPosting = {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
};
type WorkdayListResponse = {
  total?: number;
  jobPostings?: WorkdayListPosting[];
};

type WorkdayPayRange = {
  minValue?: number;
  maxValue?: number;
  currency?: string;
  frequency?: { descriptor?: string };
};
type WorkdayJobPostingInfo = {
  id?: string;
  title?: string;
  jobDescription?: string;
  location?: string;
  additionalLocations?: string[];
  postedOn?: string;
  startDate?: string;
  timeType?: string;
  jobReqId?: string;
  jobPostingId?: string;
  country?: { descriptor?: string };
  remoteType?: string;
  externalUrl?: string;
  questionnaireId?: string;
  payRanges?: WorkdayPayRange[];
};
type WorkdayDetailResponse = {
  jobPostingInfo?: WorkdayJobPostingInfo;
  hiringOrganization?: { name?: string };
};

async function fetchAllWorkday(
  tenant: string,
  shard: string,
  site: string,
): Promise<ScrapeResult> {
  const origin = `https://${tenant}.${shard}.myworkdayjobs.com`;
  const listUrl = `${origin}/wday/cxs/${tenant}/${site}/jobs`;

  const postings: WorkdayListPosting[] = [];
  let offset = 0;
  let total = 0;
  let listBytes = 0;
  let lastListSnippet = "";
  while (postings.length < WORKDAY_MAX_DETAIL_JOBS) {
    const body = JSON.stringify({
      appliedFacets: {},
      limit: WORKDAY_PAGE_LIMIT,
      offset,
      searchText: "",
    });
    const res = await fetchText(listUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });
    if (!res.ok) {
      // 422 from `/wday/cxs/{tenant}/{site}/jobs` means Workday's edge accepted
      // the request shape but the tenant isn't hosted on this shard (the host
      // resolves regardless — myworkdayjobs.com is a wildcard). It is NOT a
      // verb/UA/anti-bot problem (404 = wrong site, 400 = wrong verb). So the
      // stored tenant/shard/site is wrong, or the company isn't on Workday at
      // all. The fix is re-resolving the board from the careers page, not
      // retrying — surface that so callers don't mis-attribute it to scraping.
      const hint = /:\s*422\b/.test(res.error)
        ? ` — 422 = tenant "${tenant}" is not on shard "${shard}" (wrong tenant/shard/site or the company isn't on Workday); re-resolve the board URL from the careers page (the shard is unguessable)`
        : "";
      return { ok: false, error: `workday list ${res.error}${hint}` };
    }
    listBytes += res.text.length;
    if (!lastListSnippet) lastListSnippet = res.text.slice(0, 400);
    let parsed: WorkdayListResponse;
    try {
      parsed = JSON.parse(res.text) as WorkdayListResponse;
    } catch {
      return { ok: false, error: `workday list ${listUrl}: invalid JSON` };
    }
    if (typeof parsed.total === "number") total = parsed.total;
    const batch = Array.isArray(parsed.jobPostings) ? parsed.jobPostings : [];
    if (batch.length === 0) break;
    for (const p of batch) {
      if (postings.length >= WORKDAY_MAX_DETAIL_JOBS) break;
      postings.push(p);
    }
    if (batch.length < WORKDAY_PAGE_LIMIT) break;
    offset += WORKDAY_PAGE_LIMIT;
  }

  // Fan-out detail fetches in concurrency-capped batches.
  const jobs: ScrapedJob[] = [];
  for (let i = 0; i < postings.length; i += WORKDAY_DETAIL_CONCURRENCY) {
    const chunk = postings.slice(i, i + WORKDAY_DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((p) => fetchWorkdayDetail(origin, tenant, site, p)),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) jobs.push(s.value);
    }
  }

  // Against what we RETURNED, not against the cap: a detail fetch that failed
  // drops a job from `jobs` without the cap ever biting, and that gap is the
  // same lie as a capped board — a posting the board still lists is missing
  // from our snapshot. Closure detection reads this to decide whether the
  // absence of a posting is evidence it came down.
  const truncated = total > jobs.length;
  return {
    ok: true,
    data: {
      companyName: titleCaseSlug(tenant),
      jobs,
      diagnostics: {
        provider: "workday",
        fetchedUrl: listUrl,
        pageLength: listBytes,
        pageSnippet: lastListSnippet,
        ...(truncated ? { truncatedAt: jobs.length } : {}),
      },
    },
  };
}

function workdayCompFromPayRanges(
  ranges?: WorkdayPayRange[],
): string | undefined {
  if (!ranges?.length) return undefined;
  const r = ranges[0];
  if (typeof r.minValue !== "number" && typeof r.maxValue !== "number")
    return undefined;
  const cur = r.currency || "USD";
  const freq = r.frequency?.descriptor;
  const fmt = (n?: number) =>
    typeof n === "number"
      ? n.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : "?";
  const range =
    typeof r.minValue === "number" && typeof r.maxValue === "number"
      ? `${fmt(r.minValue)}–${fmt(r.maxValue)}`
      : typeof r.minValue === "number"
        ? `${fmt(r.minValue)}+`
        : `up to ${fmt(r.maxValue)}`;
  return [cur, range, freq].filter(Boolean).join(" ");
}

async function fetchWorkdayDetail(
  origin: string,
  tenant: string,
  site: string,
  posting: WorkdayListPosting,
): Promise<ScrapedJob | null> {
  if (!posting.externalPath || !posting.title) return null;
  const url = `${origin}/wday/cxs/${tenant}/${site}${posting.externalPath}`;
  const res = await fetchText(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  let data: WorkdayDetailResponse;
  try {
    data = JSON.parse(res.text) as WorkdayDetailResponse;
  } catch {
    return null;
  }
  const info = data.jobPostingInfo;
  if (!info) return null;
  const sourceUrl =
    info.externalUrl || `${origin}/${site}${posting.externalPath}`;
  const locations = [info.location, ...(info.additionalLocations ?? [])].filter(
    Boolean,
  ) as string[];
  const remoteHint =
    info.remoteType && /remote/i.test(info.remoteType) ? "Remote" : null;
  const location =
    locations.length > 0
      ? [locations.join(" • "), remoteHint].filter(Boolean).join(" • ")
      : (remoteHint ?? undefined);
  const compensation = workdayCompFromPayRanges(info.payRanges);
  const parts: string[] = [];
  parts.push(info.title ?? posting.title);
  const meta = [
    location,
    info.timeType,
    info.jobReqId ? `Req ${info.jobReqId}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  if (meta) parts.push(meta);
  if (compensation) parts.push(`Compensation: ${compensation}`);
  parts.push("");
  parts.push(htmlToText(info.jobDescription ?? ""));
  return {
    title: info.title ?? posting.title,
    sourceUrl,
    rawContent: parts.join("\n").trim(),
    location,
    employmentType: info.timeType || undefined,
    compensation,
    // jobPostingInfo carries country, startDate (real posting date — postedOn is
    // a relative "Posted Today" string), remoteType, jobReqId, etc.
    attributes: rawAttrs(info),
  };
}

type WorkdayQuestion = {
  id?: string;
  body?: string;
  required?: boolean;
  type?: { descriptor?: string };
};
type WorkdayQuestionnaire = { id?: string; questions?: WorkdayQuestion[] };

async function fetchWorkdayQuestions(
  jobSourceUrl: string,
): Promise<ApplicationQuestionsEnvelope> {
  const m = jobSourceUrl.match(WORKDAY_JOB_RE);
  if (!m) {
    return {
      status: "error",
      error: `not a recognized workday job url: ${jobSourceUrl}`,
      fetchedAt: new Date().toISOString(),
    };
  }
  const tenant = m[1];
  const shard = m[2].toLowerCase();
  const site = m[3];
  const externalPath = m[4];
  const origin = `https://${tenant}.${shard}.myworkdayjobs.com`;
  const detailUrl = `${origin}/wday/cxs/${tenant}/${site}${externalPath}`;
  const detailRes = await fetchText(detailUrl, {
    headers: { Accept: "application/json" },
  });
  if (!detailRes.ok) {
    return {
      status: "error",
      error: detailRes.error,
      fetchedAt: new Date().toISOString(),
    };
  }
  let detail: WorkdayDetailResponse;
  try {
    detail = JSON.parse(detailRes.text) as WorkdayDetailResponse;
  } catch {
    return {
      status: "error",
      error: "invalid JSON in workday detail",
      fetchedAt: new Date().toISOString(),
    };
  }
  const questionnaireId = detail.jobPostingInfo?.questionnaireId;
  if (!questionnaireId) {
    // No custom questions on this posting — apply flow is just resume + standard fields.
    return { status: "empty", fetchedAt: new Date().toISOString() };
  }
  // The questionnaire endpoint sits at the TENANT level — no `/{site}/` segment,
  // unlike the jobs/detail endpoints. Id comes from jobPostingInfo above.
  const qUrl = `${origin}/wday/cxs/${tenant}/questionnaire/${questionnaireId}`;
  const qRes = await fetchText(qUrl, {
    headers: { Accept: "application/json" },
  });
  if (!qRes.ok) {
    return {
      status: "error",
      error: qRes.error,
      fetchedAt: new Date().toISOString(),
    };
  }
  let qData: WorkdayQuestionnaire;
  try {
    qData = JSON.parse(qRes.text) as WorkdayQuestionnaire;
  } catch {
    return {
      status: "error",
      error: "invalid JSON in workday questionnaire",
      fetchedAt: new Date().toISOString(),
    };
  }
  const questions: ApplicationQuestion[] = [];
  for (const q of qData.questions ?? []) {
    const body = htmlToText(q.body ?? "").trim();
    if (!body) continue;
    const item: ApplicationQuestion = { question: body };
    if (q.required) item.required = true;
    if (q.type?.descriptor) item.type = q.type.descriptor;
    questions.push(item);
  }
  if (questions.length === 0)
    return { status: "empty", fetchedAt: new Date().toISOString() };
  return { status: "ok", questions, fetchedAt: new Date().toISOString() };
}

export const workday: AtsProviderModule = {
  provider: "workday",
  hostFragments: ["myworkdayjobs.com"],
  supportsQuestions: true,
  detect(url) {
    const m = url.match(WORKDAY_RE);
    if (!m) return null;
    const tenant = m[1];
    const site = m[2];
    const shardMatch = url.match(/\.(wd\d+)\.myworkdayjobs\.com/i);
    const shard = shardMatch ? shardMatch[1].toLowerCase() : "wd1";
    const origin = `https://${tenant}.${shard}.myworkdayjobs.com`;
    return {
      provider: "workday",
      fetchedUrl: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
      fetchAll: () => fetchAllWorkday(tenant, shard, site),
    };
  },
  matchesQuestions(url) {
    return WORKDAY_RE.test(url);
  },
  fetchQuestions(url) {
    return fetchWorkdayQuestions(url);
  },
};
