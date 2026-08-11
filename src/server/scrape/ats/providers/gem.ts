import { decodeEntities, htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
  ScrapeResult,
  ScrapedJob,
} from "../../types";

const GEM_RE = /^https?:\/\/jobs\.gem\.com\/([^/?#]+)/i;
// -- Gem ------------------------------------------------------------------
//
// Gem hosted boards (jobs.gem.com/{vanity}) are an Apollo SPA against
// `/api/public/graphql`. Two queries cover us:
//   JobBoardList({boardId})  → list of postings + filters + board metadata.
//                              We extend the SPA's selection set with
//                              `descriptionHtml` so a single GraphQL call
//                              returns everything for the list view.
//   ExternalJobPostingQuery({boardId, extId}) — per-job detail + the
//   oatsJobPostFieldsAndQuestions(...) sibling which exposes the application
//   form's custom questions (PublicQuestionFragment).
//
// Reverse-engineered from static.gem.com/scripts/{jobBoards,...}.v2.min.js
// (2026-06-08). Drift risk: the SPA can change the selection set at any
// time. If GraphQL errors stop including the fields below, the JS bundle is
// the source of truth — grep `static.gem.com/scripts/*.v2.min.js` for
// `oatsExternalJobPostings`/`oatsJobPostFieldsAndQuestions`/
// `PublicQuestionFragment` and update accordingly.
//
// NO PAGINATION IS AVAILABLE, and this is a known blind spot rather than an
// omission: `oatsExternalJobPostings(boardId:)` takes no paging arguments,
// introspection is disabled, and Gem masks every GraphQL error — so an
// invented argument name can't even be tested. The response carries no
// pageInfo/totalCount either, which means that if Gem ever caps this list
// server-side we get page one with NO way to detect it and therefore no
// `truncatedAt`. Closure detection would then read the missing tail as taken
// down. Re-probe the JS bundle for a paged query before trusting a big Gem
// board.

const GEM_GRAPHQL_URL = "https://jobs.gem.com/api/public/graphql";

const GEM_LIST_QUERY = `query JobBoardList($boardId: String!) {
  oatsExternalJobPostings(boardId: $boardId) {
    jobPostings {
      id
      extId
      title
      descriptionHtml
      compensationHtml
      locations { id name city isoCountry isRemote }
      job { id locationType employmentType department { id name } }
    }
  }
  jobBoardExternal(vanityUrlPath: $boardId) {
    id
    teamDisplayName
  }
}`;

const GEM_DETAIL_QUERY = `query ExternalJobPostingQuery($boardId: String!, $extId: String!) {
  oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
    id
    title
    descriptionHtml
    extId
    locations { id extId name city isoCountry isRemote }
    job { id locationType employmentType requisitionId department { id name } }
    jobPostSectionHtml { introHtml outroHtml }
    compensationHtml
  }
  oatsJobPostFieldsAndQuestions(jobBoardVanityPath: $boardId, jobPostExtId: $extId) {
    fields { fieldType isRequired }
    questions { ...PublicQuestionFragment }
  }
}
fragment PublicQuestionFragment on PublicOatsQuestion {
  extId
  answerType
  displayType
  fileType
  text
  description
  isRequired
}`;

// extId can be either a plain numeric string (legacy postings) or a base64url
// blob (newer Relay-shaped IDs containing 0-9A-Za-z_-). The slug + extId pair
// is the only thing the GraphQL detail query needs, so accept anything that
// isn't a path separator and let the GraphQL call reject bad IDs server-side.
const GEM_JOB_RE = /^https?:\/\/jobs\.gem\.com\/([^/?#]+)\/([^/?#]+)/i;

type GemLocation = {
  id?: string;
  extId?: string;
  name?: string;
  city?: string;
  isoCountry?: string;
  isRemote?: boolean;
};
type GemJobPosting = {
  id?: string;
  extId?: string;
  title?: string;
  descriptionHtml?: string;
  compensationHtml?: string;
  locations?: GemLocation[];
  job?: {
    locationType?: string;
    employmentType?: string;
    requisitionId?: string;
    department?: { name?: string };
  };
  jobPostSectionHtml?: { introHtml?: string; outroHtml?: string };
};
type GemListResponse = {
  data?: {
    oatsExternalJobPostings?: { jobPostings?: GemJobPosting[] };
    jobBoardExternal?: { teamDisplayName?: string };
  };
  errors?: Array<{ message?: string }>;
};
type GemPublicQuestion = {
  extId?: string;
  answerType?: string;
  displayType?: string;
  fileType?: string;
  text?: string;
  description?: string;
  isRequired?: boolean;
};
type GemDetailResponse = {
  data?: {
    oatsExternalJobPosting?: GemJobPosting | null;
    oatsJobPostFieldsAndQuestions?: {
      questions?: GemPublicQuestion[];
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

async function postGem<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: true; data: T; text: string } | { ok: false; error: string }> {
  const res = await fetchText(GEM_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Apollo client identification headers the bundle ships — keeps us
      // on the same code path as the SPA so behavior diverges less.
      "apollographql-client-name": "gem-jobs-public",
      "apollographql-client-version": "hank-1.0",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return { ok: false, error: res.error };
  let parsed: { data?: T; errors?: Array<{ message?: string }> };
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { ok: false, error: `gem graphql: invalid JSON` };
  }
  if (parsed.errors?.length) {
    return {
      ok: false,
      error: `gem graphql: ${parsed.errors.map((e) => e.message ?? "?").join("; ")}`,
    };
  }
  return { ok: true, data: parsed.data as T, text: res.text };
}

function gemLocationLabel(locs?: GemLocation[]): string | undefined {
  if (!locs?.length) return undefined;
  const labels = locs
    .map((l) => {
      const base = l.name || [l.city, l.isoCountry].filter(Boolean).join(", ");
      return l.isRemote ? `${base} (Remote)` : base;
    })
    .filter(Boolean);
  return labels.length > 0 ? labels.join(" • ") : undefined;
}

function gemJobToScraped(slug: string, p: GemJobPosting): ScrapedJob | null {
  if (!p.extId || !p.title) return null;
  const sourceUrl = `https://jobs.gem.com/${slug}/${p.extId}`;
  const location = gemLocationLabel(p.locations);
  const compensation = p.compensationHtml
    ? htmlToText(p.compensationHtml).trim() || undefined
    : undefined;
  const department = p.job?.department?.name;
  const employmentType = p.job?.employmentType;
  const parts: string[] = [];
  parts.push(p.title);
  const meta = [location, department, employmentType, p.job?.locationType]
    .filter(Boolean)
    .join(" • ");
  if (meta) parts.push(meta);
  if (compensation) parts.push(`Compensation: ${compensation}`);
  parts.push("");
  const intro = p.jobPostSectionHtml?.introHtml;
  const outro = p.jobPostSectionHtml?.outroHtml;
  if (intro) {
    parts.push(htmlToText(intro), "");
  }
  parts.push(htmlToText(p.descriptionHtml ?? ""));
  if (outro) parts.push("", htmlToText(outro));
  return {
    title: p.title,
    sourceUrl,
    rawContent: parts.join("\n").trim(),
    location,
    department: department || undefined,
    employmentType: employmentType || undefined,
    compensation,
    // Gem nests the useful scalars under `job` (locationType, employmentType,
    // requisitionId, …); spread them up alongside `locations`, drop the wrapper.
    attributes: rawAttrs({ ...(p as object), ...(p.job ?? {}) }, ["job"]),
  };
}

async function fetchAllGem(slug: string): Promise<ScrapeResult> {
  const res = await postGem<GemListResponse["data"]>(GEM_LIST_QUERY, {
    boardId: slug,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const data = res.data ?? {};
  const postings = data.oatsExternalJobPostings?.jobPostings ?? [];
  const companyName =
    data.jobBoardExternal?.teamDisplayName?.trim() || titleCaseSlug(slug);
  const jobs = postings
    .map((p) => gemJobToScraped(slug, p))
    .filter((j): j is ScrapedJob => j !== null);
  return {
    ok: true,
    data: {
      companyName,
      jobs,
      diagnostics: {
        provider: "gem",
        fetchedUrl: GEM_GRAPHQL_URL,
        pageLength: res.text.length,
        pageSnippet: res.text.slice(0, 400),
      },
    },
  };
}

async function fetchGemQuestions(
  jobSourceUrl: string,
): Promise<ApplicationQuestionsEnvelope> {
  const m = jobSourceUrl.match(GEM_JOB_RE);
  if (!m) {
    return {
      status: "error",
      error: `not a recognized gem job url: ${jobSourceUrl}`,
      fetchedAt: new Date().toISOString(),
    };
  }
  const [, slug, extId] = m;
  const res = await postGem<GemDetailResponse["data"]>(GEM_DETAIL_QUERY, {
    boardId: slug,
    extId,
  });
  if (!res.ok) {
    return {
      status: "error",
      error: res.error,
      fetchedAt: new Date().toISOString(),
    };
  }
  const rawQuestions = res.data?.oatsJobPostFieldsAndQuestions?.questions ?? [];
  const questions: ApplicationQuestion[] = [];
  for (const q of rawQuestions) {
    const text = decodeEntities(q.text ?? "").trim();
    if (!text) continue;
    const item: ApplicationQuestion = { question: text };
    if (q.isRequired) item.required = true;
    if (q.answerType) item.type = q.answerType;
    questions.push(item);
  }
  if (questions.length === 0)
    return { status: "empty", fetchedAt: new Date().toISOString() };
  return { status: "ok", questions, fetchedAt: new Date().toISOString() };
}

export const gem: AtsProviderModule = {
  provider: "gem",
  detect(url) {
    const m = url.match(GEM_RE);
    if (!m) return null;
    const slug = m[1];
    return {
      provider: "gem",
      fetchedUrl: `https://jobs.gem.com/api/public/graphql`,
      fetchAll: () => fetchAllGem(slug),
    };
  },
  matchesQuestions(url) {
    return GEM_RE.test(url);
  },
  fetchQuestions(url) {
    return fetchGemQuestions(url);
  },
};
