import { isRecord } from "@/utils/guards";
import { htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { scrapeFetchSignal } from "../../scrapeSignal";
import { rawAttrs, type AtsProviderModule } from "../shared";

import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
  ScrapedCompany,
  ScrapedJob,
} from "../../types";

const ASHBY_RE = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i;
const ASHBY_API_RE =
  /^https?:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i;
// -- Ashby ----------------------------------------------------------------

type AbSecondaryLocation = { location?: string };
// Shape of the PUBLIC Ashby posting API (api.ashbyhq.com/posting-api/job-board/
// {slug}). These are the REST field names — `location`, `secondaryLocations`,
// `department`, `descriptionPlain`/`descriptionHtml`, nested `compensation`.
// An earlier version of this parser read the internal Apollo board API's names
// instead (`locationName` / `departmentName` / `descriptionParts` /
// `compensationTierSummary`), none of which exist on this endpoint — so every
// field silently came back undefined: `location` collapsed to "Remote"/null and
// department + compensation were always blank for every Ashby company. See
// docs/ats-scrapers.md → Ashby.
type AbJob = {
  id: string;
  title: string;
  jobUrl: string;
  applyUrl?: string;
  department?: string;
  team?: string;
  location?: string;
  secondaryLocations?: AbSecondaryLocation[];
  employmentType?: string;
  isRemote?: boolean;
  workplaceType?: string; // "Remote" | "Hybrid" | "OnSite"
  publishedAt?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: {
    compensationTierSummary?: string | null;
    scrapeableCompensationSalarySummary?: string | null;
  };
};

function ashbyWorkplaceLabel(wt?: string): string | undefined {
  switch (wt) {
    case "Remote":
      return "Remote";
    case "Hybrid":
      return "Hybrid";
    case "OnSite":
      return "On-site";
    default:
      return undefined;
  }
}

// Build a human location from the primary + secondary cities plus a workplace
// suffix. `workplaceType` is authoritative for remote/hybrid/on-site; Ashby's
// `isRemote` flag is NOT — it comes back `true` even for Hybrid roles anchored
// to a city (every Notion "Hybrid" posting has isRemote=true), so trusting it
// mislabels city-based jobs as "Remote". Only fall back to isRemote when there's
// no city and no workplaceType.
function ashbyLocation(j: AbJob): string | undefined {
  const seen = new Set<string>();
  const places = [
    j.location,
    ...(j.secondaryLocations ?? []).map((s) => s?.location),
  ]
    .filter((s): s is string => Boolean(s))
    .filter((s) => {
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const workplace =
    ashbyWorkplaceLabel(j.workplaceType) ??
    (places.length === 0 && j.isRemote ? "Remote" : undefined);
  const out = [...places, workplace].filter(Boolean).join(" • ");
  return out || undefined;
}

function parseAshby(data: unknown, slug: string): ScrapedCompany {
  if (!isRecord(data)) throw new Error("ashby: unexpected shape");
  const jobBoardName =
    typeof data.jobBoardName === "string"
      ? data.jobBoardName
      : titleCaseSlug(slug);
  const list = Array.isArray(data.jobs) ? (data.jobs as AbJob[]) : [];
  const jobs: ScrapedJob[] = list.map((j) => {
    const location = ashbyLocation(j);
    const compensation =
      j.compensation?.compensationTierSummary ||
      j.compensation?.scrapeableCompensationSalarySummary ||
      undefined;
    const parts: string[] = [];
    parts.push(j.title);
    const meta = [j.department, location, j.employmentType]
      .filter(Boolean)
      .join(" • ");
    if (meta) parts.push(meta);
    if (compensation) parts.push(`Compensation: ${compensation}`);
    parts.push("");
    parts.push(j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ""));
    return {
      title: j.title,
      sourceUrl: j.jobUrl,
      rawContent: parts.join("\n").trim(),
      location,
      department: j.department || undefined,
      compensation,
      employmentType: j.employmentType || undefined,
      attributes: rawAttrs(j),
    };
  });
  return { companyName: jobBoardName, jobs };
}
// -- Ashby ----------------------------------------------------------------
//
// Ashby's documented `jobPosting.info` API requires an org API key, which we
// don't have. The hosted job board at jobs.ashbyhq.com/<slug> is a Vite/Apollo
// SPA that fetches the form from an unauthenticated GraphQL endpoint —
// `POST /api/non-user-graphql?op=ApiJobPosting`. The query below was
// reconstructed from the SPA bundle's compiled GraphQL AST. It returns the
// whole form including custom short-answer (LongText) questions.
//
// Drift risk: it's an SPA-defined query, so the selection set can change
// without notice. If it ever stops parsing we fall back to a minimal hand-
// written query that only asks for what we actually need. If both queries
// start returning `{errors: [...]}`, here's how to re-derive ASHBY_FULL_QUERY:
//
//   1. Open any Ashby hosted apply page, view source, copy the URL of the
//      `vite-preload` <link> — that's the manifest, e.g.
//      cdn.ashbyprd.com/frontend_non_user/<hash>/.vite/manifest.json
//   2. Fetch the manifest, grab `index.html.file` (an `assets/index-*.js`
//      path under the same CDN host), download that bundle.
//   3. Grep for `value:"ApiJobPosting"` in the bundle. The match sits inside
//      a JS object-literal AST blob beginning with `{kind:"Document",
//      definitions:[{kind:"OperationDefinition",operation:"query",
//      name:{kind:"Name",value:"ApiJobPosting"}...`. Walk back to that
//      `{kind:"Document"` boundary, then walk braces forward to find the end.
//   4. The extracted blob is a valid JS expression. Eval it in Node and run
//      it through GraphQL's `print()` (or any AST printer). Drop the result
//      into ASHBY_FULL_QUERY below.
//   5. Other op names worth knowing (also in the bundle, same AST pattern):
//      ApiJobPostingForApplicationRequest, ApiOrganizationFromHostedJobsPageName,
//      ApiSubmitSingleApplicationFormAction.

const ASHBY_JOB_RE =
  /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i;

const ASHBY_FORM_FRAGMENTS = `
fragment JSONBoxParts on JSONBox { value }
fragment FileParts on File { id filename }
fragment FormFieldEntryParts on FormFieldEntry {
  id
  field
  fieldValue {
    ... on JSONBox { ...JSONBoxParts }
    ... on File { ...FileParts }
    ... on FileList { files { ...FileParts } }
  }
  isRequired
  descriptionHtml
  isHidden
}
fragment FormRenderParts on FormRender {
  id
  sections {
    title
    descriptionHtml
    fieldEntries { ...FormFieldEntryParts }
    isHidden
  }
  sourceFormDefinitionId
}`;

const ASHBY_FULL_QUERY = `
query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id
    title
    applicationForm { ...FormRenderParts }
  }
}
${ASHBY_FORM_FRAGMENTS}`;

// Minimal fallback if the full query ever 4xxs from schema drift.
const ASHBY_MIN_QUERY = `
query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id
    title
    applicationForm {
      sections {
        fieldEntries { id field isRequired isHidden }
        isHidden
      }
    }
  }
}`;

type AshbyFieldDef = {
  title?: string;
  path?: string;
  type?: string;
};
type AshbyFieldEntry = {
  id?: string;
  field?: string | AshbyFieldDef;
  isRequired?: boolean;
  isHidden?: boolean;
};
type AshbySection = {
  fieldEntries?: AshbyFieldEntry[];
  isHidden?: boolean;
};
type AshbyResponse = {
  data?: {
    jobPosting?: {
      applicationForm?: { sections?: AshbySection[] } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

async function postAshbyQuery(
  slug: string,
  jobPostingId: string,
  query: string,
): Promise<AshbyResponse | { httpError: string }> {
  const res = await fetch(
    "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "HankBot/0.1",
      },
      body: JSON.stringify({
        operationName: "ApiJobPosting",
        variables: { organizationHostedJobsPageName: slug, jobPostingId },
        query,
      }),
      signal: scrapeFetchSignal(20_000),
    },
  );
  if (!res.ok) return { httpError: `${res.status} ${res.statusText}` };
  return (await res.json()) as AshbyResponse;
}

// An open-ended "additional information / additional attachments / anything
// else" field is the applicant's free-form pitch slot — treated by the decider
// as cover-letter-equivalent. Detected by title so it survives a provider
// modeling it as a built-in/system field, which would otherwise drop it.
function isAdditionalInfoTitle(title: string): boolean {
  return /\badditional\s+(information|attachments?|files?|materials?|documents?|comments?)\b|\banything\s+else\b/i.test(
    title,
  );
}

async function fetchAshbyQuestions(
  jobSourceUrl: string,
): Promise<ApplicationQuestionsEnvelope> {
  const m = jobSourceUrl.match(ASHBY_JOB_RE);
  if (!m) {
    return {
      status: "error",
      error: `not a recognized ashby job url: ${jobSourceUrl}`,
      fetchedAt: new Date().toISOString(),
    };
  }
  const [, slug, jobPostingId] = m;
  try {
    let json = await postAshbyQuery(slug, jobPostingId, ASHBY_FULL_QUERY);
    if ("httpError" in json) {
      return {
        status: "error",
        error: json.httpError,
        fetchedAt: new Date().toISOString(),
      };
    }
    if (json.errors?.length) {
      // Try the minimal selection set in case the full query has drifted.
      json = await postAshbyQuery(slug, jobPostingId, ASHBY_MIN_QUERY);
      if ("httpError" in json) {
        return {
          status: "error",
          error: json.httpError,
          fetchedAt: new Date().toISOString(),
        };
      }
      if (json.errors?.length) {
        return {
          status: "error",
          error: `graphql: ${json.errors.map((e) => e.message ?? "?").join("; ")}`,
          fetchedAt: new Date().toISOString(),
        };
      }
    }
    const form = json.data?.jobPosting?.applicationForm;
    if (!form) return { status: "empty", fetchedAt: new Date().toISOString() };

    const questions: ApplicationQuestion[] = [];
    for (const section of form.sections ?? []) {
      if (section.isHidden) continue;
      for (const fe of section.fieldEntries ?? []) {
        if (fe.isHidden) continue;
        let field: AshbyFieldDef;
        try {
          field =
            typeof fe.field === "string"
              ? (JSON.parse(fe.field) as AshbyFieldDef)
              : (fe.field ?? {});
        } catch {
          continue;
        }
        const title = (field.title ?? "").trim();
        // Skip Ashby's built-in fields (name, email, resume, phone, location,
        // etc). EXCEPTION: an open-ended "additional information / additional
        // attachments / anything else you'd like us to know" field — even when
        // Ashby models it as a system field — is the applicant's free-form pitch
        // slot. Surface it so the decider can draft a cover-letter-style answer
        // instead of silently dropping it (the Snowflake "missed additional
        // attachments" report).
        if (
          typeof field.path === "string" &&
          field.path.startsWith("_systemfield_") &&
          !isAdditionalInfoTitle(title)
        ) {
          continue;
        }
        if (!title) continue;
        const q: ApplicationQuestion = { question: title };
        if (fe.isRequired) q.required = true;
        if (field.type) q.type = field.type;
        questions.push(q);
      }
    }
    if (questions.length === 0) {
      return { status: "empty", fetchedAt: new Date().toISOString() };
    }
    return { status: "ok", questions, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      fetchedAt: new Date().toISOString(),
    };
  }
}

export const ashby: AtsProviderModule = {
  provider: "ashby",
  hostFragments: ["ashbyhq.com"],
  supportsQuestions: true,
  detect(url) {
    const m = url.match(ASHBY_RE) ?? url.match(ASHBY_API_RE);
    if (!m) return null;
    const slug = m[1];
    return {
      provider: "ashby",
      jsonUrl: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
      parse: (data) => parseAshby(data, slug),
    };
  },
  matchesQuestions(url) {
    return ASHBY_RE.test(url) || ASHBY_API_RE.test(url);
  },
  fetchQuestions(url) {
    return fetchAshbyQuestions(url);
  },
};
