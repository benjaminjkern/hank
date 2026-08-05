import { decodeEntities, htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
  ScrapeResult,
  ScrapedJob,
} from "../../types";

const TEAMTAILOR_RE = /^https?:\/\/([a-z0-9-]+)\.teamtailor\.com\//i;
// -- Teamtailor ----------------------------------------------------------
//
// Public boards expose a JSON Feed at `https://{slug}.teamtailor.com/jobs.json`
// (https://www.jsonfeed.org/version/1.1/). Each item carries full
// `content_html` + a `_jobposting` extension that's a schema.org JobPosting
// (jobLocation with PostalAddress, baseSalary when set, employmentType).
// Pagination uses `?page=N`; absent next_url + empty items signals done.
//
// Application questions: the apply page at `/jobs/{numericId}/applications/new`
// is server-rendered Rails. Each `<div class="question ..."` block has a
// hidden `candidate[answers_attributes][N][question_id]` input plus a
// <legend><span class="block">QUESTION</span></legend> (multi-choice) or
// <label for="candidate_answers_attributes_N_text">QUESTION</label> (text).
// Custom domains (jobs.{company}.com) work via redirect — set redirect:follow.

const TEAMTAILOR_PAGE_SIZE_HINT = 30;
const TEAMTAILOR_MAX_PAGES = 20;

const TEAMTAILOR_JOB_RE =
  /^https?:\/\/[a-z0-9-]+\.teamtailor\.com\/jobs\/(\d+)/i;

type TeamtailorJobLocation = {
  "@type"?: string;
  address?: {
    streetAddress?: string;
    addressLocality?: string;
    addressRegion?: string;
    addressCountry?: string;
  };
};
type TeamtailorJobPosting = {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string;
  jobLocation?: TeamtailorJobLocation | TeamtailorJobLocation[];
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number; unitText?: string };
  };
  hiringOrganization?: { name?: string };
};
type TeamtailorFeedItem = {
  id?: string;
  title?: string;
  url?: string;
  date_published?: string;
  content_html?: string;
  tags?: string[];
  _jobposting?: TeamtailorJobPosting;
};
type TeamtailorFeed = {
  title?: string;
  home_page_url?: string;
  feed_url?: string;
  next_url?: string;
  items?: TeamtailorFeedItem[];
};

function teamtailorLocation(jp?: TeamtailorJobPosting): string | undefined {
  if (!jp?.jobLocation) return undefined;
  const arr = Array.isArray(jp.jobLocation) ? jp.jobLocation : [jp.jobLocation];
  const labels = arr
    .map((loc) => {
      const a = loc.address;
      if (!a) return null;
      return [a.addressLocality, a.addressRegion, a.addressCountry]
        .filter(Boolean)
        .join(", ");
    })
    .filter((s): s is string => !!s);
  return labels.length > 0 ? labels.join(" • ") : undefined;
}

function teamtailorCompensation(jp?: TeamtailorJobPosting): string | undefined {
  const v = jp?.baseSalary?.value;
  if (!v) return undefined;
  const cur = jp?.baseSalary?.currency || "";
  const min = typeof v.minValue === "number" ? v.minValue : undefined;
  const max = typeof v.maxValue === "number" ? v.maxValue : undefined;
  if (typeof min !== "number" && typeof max !== "number") return undefined;
  const fmt = (n: number) =>
    n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const range =
    typeof min === "number" && typeof max === "number"
      ? `${fmt(min)}–${fmt(max)}`
      : typeof min === "number"
        ? `${fmt(min)}+`
        : `up to ${fmt(max as number)}`;
  return [cur, range, v.unitText].filter(Boolean).join(" ");
}

async function fetchAllTeamtailor(slug: string): Promise<ScrapeResult> {
  const base = `https://${slug}.teamtailor.com/jobs.json`;
  const items: TeamtailorFeedItem[] = [];
  let companyName = titleCaseSlug(slug);
  let totalBytes = 0;
  let firstSnippet = "";
  let nextUrl: string | undefined = base;
  let page = 1;
  while (nextUrl && page <= TEAMTAILOR_MAX_PAGES) {
    const res = await fetchText(nextUrl, {
      headers: {
        Accept: "application/feed+json, application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) {
      if (page === 1) return { ok: false, error: `teamtailor ${res.error}` };
      break;
    }
    totalBytes += res.text.length;
    if (!firstSnippet) firstSnippet = res.text.slice(0, 400);
    let parsed: TeamtailorFeed;
    try {
      parsed = JSON.parse(res.text) as TeamtailorFeed;
    } catch {
      if (page === 1) {
        return { ok: false, error: `teamtailor ${nextUrl}: invalid JSON` };
      }
      break;
    }
    if (parsed.title)
      companyName = parsed.title.replace(/\s+jobs$/i, "").trim() || companyName;
    const batch = Array.isArray(parsed.items) ? parsed.items : [];
    if (batch.length === 0) break;
    items.push(...batch);
    if (parsed.next_url) {
      nextUrl = parsed.next_url;
    } else if (batch.length >= TEAMTAILOR_PAGE_SIZE_HINT) {
      // Feed didn't supply next_url but the page is full — try ?page=N+1.
      page += 1;
      nextUrl = `${base}?page=${page}`;
    } else {
      nextUrl = undefined;
    }
  }

  const jobs: ScrapedJob[] = items
    .map((item) => parseTeamtailorItem(item))
    .filter((j): j is ScrapedJob => j !== null);

  return {
    ok: true,
    data: {
      companyName,
      jobs,
      diagnostics: {
        provider: "teamtailor",
        fetchedUrl: base,
        pageLength: totalBytes,
        pageSnippet: firstSnippet,
      },
    },
  };
}

function parseTeamtailorItem(item: TeamtailorFeedItem): ScrapedJob | null {
  if (!item.url || !item.title) return null;
  const jp = item._jobposting;
  const location = teamtailorLocation(jp);
  const compensation = teamtailorCompensation(jp);
  const employmentType = jp?.employmentType;
  const parts: string[] = [];
  parts.push(item.title);
  const meta = [location, employmentType].filter(Boolean).join(" • ");
  if (meta) parts.push(meta);
  if (compensation) parts.push(`Compensation: ${compensation}`);
  parts.push("");
  parts.push(htmlToText(item.content_html ?? jp?.description ?? ""));
  return {
    title: item.title,
    sourceUrl: item.url,
    rawContent: parts.join("\n").trim(),
    location,
    employmentType: employmentType || undefined,
    compensation,
    // _jobposting (schema.org) holds datePosted, jobLocation, baseSalary, etc.;
    // fold in the feed item's tags + published date.
    attributes: rawAttrs({
      ...(jp ?? {}),
      tags: item.tags,
      date_published: item.date_published,
    }),
  };
}

async function fetchTeamtailorQuestions(
  jobSourceUrl: string,
): Promise<ApplicationQuestionsEnvelope> {
  const m = jobSourceUrl.match(TEAMTAILOR_JOB_RE);
  if (!m) {
    return {
      status: "error",
      error: `not a recognized teamtailor job url: ${jobSourceUrl}`,
      fetchedAt: new Date().toISOString(),
    };
  }
  const applyUrl = `${jobSourceUrl.replace(/\/+$/, "")}/applications/new`;
  const res = await fetchText(applyUrl, {
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      // Use a normal-browser UA — some Teamtailor accounts gate the apply
      // page on Cloudflare's bot check and 403 obvious bot UAs.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    return {
      status: "error",
      error: res.error,
      fetchedAt: new Date().toISOString(),
    };
  }
  const html = res.text;
  // Match each <div class="question ..." data-question-mandatory="..."> block
  // and the next ~3KB after it. Greedy enough to span legend + inputs;
  // non-overlapping by anchoring on the opening tag.
  const blocks: Array<{ raw: string; mandatory: boolean }> = [];
  const blockRe =
    /<div\s+class="question[^"]*"[^>]*data-question-mandatory="(true|false)"[^>]*>([\s\S]*?)(?=<div\s+class="question[^"]*"|<\/form>)/gi;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html)) !== null) {
    blocks.push({ raw: bm[2], mandatory: bm[1] === "true" });
  }
  const questions: ApplicationQuestion[] = [];
  for (const { raw, mandatory } of blocks) {
    const text = extractTeamtailorQuestionText(raw);
    if (!text) continue;
    const type = extractTeamtailorQuestionType(raw);
    const q: ApplicationQuestion = { question: text };
    if (mandatory) q.required = true;
    if (type) q.type = type;
    questions.push(q);
  }
  if (questions.length === 0)
    return { status: "empty", fetchedAt: new Date().toISOString() };
  return { status: "ok", questions, fetchedAt: new Date().toISOString() };
}

function extractTeamtailorQuestionText(blockHtml: string): string | null {
  // Prefer the full <legend>…</legend> (multi-choice forms). cleanTeamtailorLabel
  // strips nested <sup data-asterisk> and <span class="sr-only">Required</span>
  // along with all other tags. Greedy-to-end with [\s\S]*? still terminates at
  // the first </legend> because question blocks have only one.
  const legendMatch = blockHtml.match(/<legend[^>]*>([\s\S]*?)<\/legend>/i);
  if (legendMatch) return cleanTeamtailorLabel(legendMatch[1]);
  // Free-text questions render a <label for="candidate_answers_attributes_N_text">.
  const labelMatch = blockHtml.match(
    /<label[^>]+for="candidate_answers_attributes_\d+[_a-z]*"[^>]*>([\s\S]*?)<\/label>/i,
  );
  if (labelMatch) return cleanTeamtailorLabel(labelMatch[1]);
  // Fallback: any <label> in the block.
  const anyLabel = blockHtml.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
  if (anyLabel) return cleanTeamtailorLabel(anyLabel[1]);
  return null;
}

function cleanTeamtailorLabel(raw: string): string | null {
  const stripped = decodeEntities(
    raw
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "")
      .replace(
        /<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>[\s\S]*?<\/span>/gi,
        "",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    // Belt-and-suspenders: even if the sr-only span survives (a class
    // reorder, an extra attribute), strip a trailing "Required" / "*Required"
    // marker so the question text stays clean.
    .replace(/[*∗]?\s*Required\s*$/i, "")
    .trim();
  return stripped || null;
}

function extractTeamtailorQuestionType(blockHtml: string): string | undefined {
  if (/data-question-multiple-choice="true"/i.test(blockHtml))
    return "multi_select";
  if (/<input[^>]+type="radio"/i.test(blockHtml)) return "single_select";
  if (/<textarea/i.test(blockHtml)) return "textarea";
  if (/<select/i.test(blockHtml)) return "select";
  if (/upload_attributes/i.test(blockHtml)) return "file";
  if (/<input[^>]+type="text"/i.test(blockHtml)) return "text";
  return undefined;
}

export const teamtailor: AtsProviderModule = {
  provider: "teamtailor",
  hostFragments: ["teamtailor.com"],
  supportsQuestions: true,
  detect(url) {
    const m = url.match(TEAMTAILOR_RE);
    if (!m) return null;
    const slug = m[1];
    return {
      provider: "teamtailor",
      fetchedUrl: `https://${slug}.teamtailor.com/jobs.json`,
      fetchAll: () => fetchAllTeamtailor(slug),
    };
  },
  matchesQuestions(url) {
    return TEAMTAILOR_RE.test(url);
  },
  fetchQuestions(url) {
    return fetchTeamtailorQuestions(url);
  },
};
