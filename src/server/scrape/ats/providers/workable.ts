import { isRecord } from "@/utils/guards";
import { decodeEntities, htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
  ScrapedCompany,
  ScrapedJob,
} from "../../types";

const WORKABLE_RE = /^https?:\/\/apply\.workable\.com\/(?!j\/)([^/?#]+)/i;
const WORKABLE_SUB_RE =
  /^https?:\/\/(?!apply\.|www\.)([a-z0-9-]+)\.workable\.com\//i;
// A single Workable job (Job.sourceUrl) — apply.workable.com/j/{shortcode}.
const WORKABLE_JOB_RE = /^https?:\/\/apply\.workable\.com\/j\/([^/?#]+)/i;
// -- Workable -------------------------------------------------------------
//
// Multi-tenant. Modern boards live at apply.workable.com/{slug}; the legacy
// form is {slug}.workable.com. The public widget endpoint
//   GET apply.workable.com/api/v1/widget/accounts/{slug}?details=true
// returns { name, description, jobs: [...] } where each job's `description`
// field is the FULL rendered posting (description + requirements concatenated —
// verified against the v2 detail endpoint), so list + detail land in one GET.
// Each job's public URL is apply.workable.com/j/{shortcode} (note: no account
// slug in it — that's why WORKABLE_JOB_RE is separate from the board regex).
//
// This endpoint ignores `limit`/`offset` and returns the whole board, so there
// is nothing to paginate and no cap here. A paginated endpoint does exist
// (POST /api/v3/accounts/{slug}/jobs, which reports a `total`), but its rows
// carry NO description — switching would turn one GET into an N+1 detail
// fan-out, which is strictly worse. Don't "fix" the missing pagination.
//
// Application questions: the candidate apply form (apply.workable.com/j/{code}/
// apply) is a JS-rendered SPA, but the SPA fetches its form definition from a
// public JSON endpoint — GET apply.workable.com/api/v1/jobs/{shortcode}/form —
// which returns sections of fields {id,label,type,required,options}. The custom
// recruiter questions are the CA_* (custom answer) + QA_* (questionnaire) ids;
// everything else is a built-in (firstname/email/resume/…). `cover_letter` is a
// built-in attachment → drives the envelope coverLetter flag. (Found by
// capturing the apply SPA's XHR with the headless launcher; the endpoint is
// directly callable, so no browser is needed at runtime.)
type WorkableWidgetJob = {
  title?: string;
  shortcode?: string;
  code?: string;
  employment_type?: string;
  telecommuting?: boolean;
  department?: string;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  country?: string;
  city?: string;
  state?: string;
  function?: string;
  industry?: string;
  description?: string;
  [k: string]: unknown;
};
type WorkableWidget = {
  name?: string;
  description?: string;
  jobs?: WorkableWidgetJob[];
};

function workableLocation(job: WorkableWidgetJob): string | undefined {
  const base = [job.city, job.state, job.country].filter(Boolean).join(", ");
  const suffix = job.telecommuting ? "Remote" : null;
  const out = [base || null, suffix].filter(Boolean).join(" • ");
  return out || undefined;
}

function parseWorkable(data: unknown, slug: string): ScrapedCompany {
  if (!isRecord(data) || !Array.isArray((data as WorkableWidget).jobs)) {
    throw new Error("workable: unexpected shape");
  }
  const widget = data as WorkableWidget;
  const jobs: ScrapedJob[] = [];
  for (const j of widget.jobs ?? []) {
    const title = (j.title ?? "").trim();
    const shortcode = j.shortcode;
    if (!title || !shortcode) continue;
    const sourceUrl =
      j.url || j.shortlink || `https://apply.workable.com/j/${shortcode}`;
    const location = workableLocation(j);
    const body = htmlToText(j.description ?? "");
    const parts: string[] = [title];
    const meta = [location, j.employment_type, j.department]
      .filter(Boolean)
      .join(" • ");
    if (meta) parts.push(meta);
    if (body) {
      parts.push("");
      parts.push(body);
    }
    jobs.push({
      title,
      sourceUrl,
      rawContent: parts.join("\n").trim(),
      location,
      department: j.department || undefined,
      employmentType: j.employment_type || undefined,
      // widget row carries telecommuting, department, function, industry,
      // country/city/state, published_on, the shortlink/apply urls, etc.
      attributes: rawAttrs(j, ["description"]),
    });
  }
  return { companyName: widget.name?.trim() || titleCaseSlug(slug), jobs };
}

type WorkableFormField = {
  id?: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: Array<{ name?: string; value?: string }>;
};
type WorkableFormSection = { name?: string; fields?: WorkableFormField[] };

// Workable's built-in (non-custom) field ids — these are the profile/PII inputs
// every form has, not recruiter questions. Custom questions are CA_*/QA_*; we
// also keep any unknown id (don't silently drop), and route cover_letter to the
// envelope flag rather than the question list.
const WORKABLE_BUILTIN_FIELD_IDS = new Set([
  "firstname",
  "lastname",
  "email",
  "phone",
  "headline",
  "address",
  "summary",
  "education",
  "experience",
  "resume",
  "photo",
  "avatar",
  "social",
  "region",
]);

async function fetchWorkableQuestions(
  jobSourceUrl: string,
): Promise<ApplicationQuestionsEnvelope> {
  const shortcode = jobSourceUrl.match(WORKABLE_JOB_RE)?.[1];
  if (!shortcode) {
    return {
      status: "error",
      error: `not a recognized workable job url: ${jobSourceUrl}`,
      fetchedAt: new Date().toISOString(),
    };
  }
  const res = await fetchText(
    `https://apply.workable.com/api/v1/jobs/${shortcode}/form`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    return {
      status: "error",
      error: res.error,
      fetchedAt: new Date().toISOString(),
    };
  }
  let sections: WorkableFormSection[];
  try {
    sections = JSON.parse(res.text) as WorkableFormSection[];
  } catch {
    return {
      status: "error",
      error: "invalid JSON in workable form",
      fetchedAt: new Date().toISOString(),
    };
  }
  const questions: ApplicationQuestion[] = [];
  let coverLetter = false;
  for (const sec of Array.isArray(sections) ? sections : []) {
    for (const f of sec.fields ?? []) {
      const id = f.id ?? "";
      if (id === "cover_letter") {
        coverLetter = true;
        continue;
      }
      if (WORKABLE_BUILTIN_FIELD_IDS.has(id)) continue;
      const label = decodeEntities(f.label ?? "").trim();
      if (!label) continue;
      const item: ApplicationQuestion = { question: label };
      if (f.required) item.required = true;
      // Pass the provider type through (paragraph→prose, dropdown/boolean→stock);
      // isProseQuestion / isStockFieldType normalize it for the decider.
      if (f.type) item.type = f.type;
      questions.push(item);
    }
  }
  const fetchedAt = new Date().toISOString();
  if (questions.length === 0)
    return { status: "empty", coverLetter, fetchedAt };
  return { status: "ok", questions, coverLetter, fetchedAt };
}

export const workable: AtsProviderModule = {
  provider: "workable",
  detect(url) {
    const m = url.match(WORKABLE_RE) ?? url.match(WORKABLE_SUB_RE);
    if (!m) return null;
    const slug = m[1];
    return {
      provider: "workable",
      jsonUrl: `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
      parse: (data) => parseWorkable(data, slug),
    };
  },
  matchesQuestions(url) {
    return (
      WORKABLE_RE.test(url) ||
      WORKABLE_SUB_RE.test(url) ||
      WORKABLE_JOB_RE.test(url)
    );
  },
  fetchQuestions(url) {
    return fetchWorkableQuestions(url);
  },
};
