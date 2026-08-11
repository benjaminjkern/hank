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

const GREENHOUSE_RE =
  /^https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/([^/?#]+)/i;
// `gh_jid` is Greenhouse's per-job ID query param. Companies with a
// custom-domain Greenhouse integration link out as
// `<company>.com/careers?gh_jid=<id>` (Databricks, Stripe, CoreWeave, …);
// the query param is the unambiguous Greenhouse jobId. Slug must come from
// elsewhere (Company.greenhouseSlug).
const GH_JID_RE = /[?&]gh_jid=([A-Za-z0-9_-]+)/i;
function extractGhJid(url: string): string | null {
  return url.match(GH_JID_RE)?.[1] ?? null;
}
// Some companies link to their API URL directly:
const GREENHOUSE_API_RE =
  /^https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/i;
export function extractGreenhouseSlugFromBoardUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const m = url.match(GREENHOUSE_RE) ?? url.match(GREENHOUSE_API_RE);
  return m ? m[1] : null;
}
// -- Greenhouse -----------------------------------------------------------

type GhJob = {
  id: number;
  title: string;
  absolute_url: string;
  content: string;
  location?: { name?: string };
  metadata?: Array<{ name?: string; value?: string | string[] | null }>;
  departments?: Array<{ name?: string }>;
  offices?: Array<{ name?: string }>;
};

function parseGreenhouse(data: unknown, slug: string): ScrapedCompany {
  if (!isRecord(data) || !Array.isArray(data.jobs))
    throw new Error("greenhouse: unexpected shape");
  const jobs: ScrapedJob[] = (data.jobs as GhJob[]).map((j) => {
    const parts: string[] = [];
    parts.push(j.title);
    if (j.location?.name) parts.push(`Location: ${j.location.name}`);
    if (j.departments?.length)
      parts.push(
        `Department: ${j.departments
          .map((d) => d.name)
          .filter(Boolean)
          .join(", ")}`,
      );
    parts.push("");
    parts.push(htmlToText(j.content ?? ""));
    if (Array.isArray(j.metadata)) {
      const meta = j.metadata
        .filter((m) => m.name && m.value)
        .map(
          (m) =>
            `${m.name}: ${Array.isArray(m.value) ? m.value.join(", ") : m.value}`,
        );
      if (meta.length) parts.push("", meta.join("\n"));
    }
    // Greenhouse hides no structured pay in the bulk list (pay_input_ranges is
    // detail-only and empty across boards we checked) — comp lives in `content`
    // / rawContent. The raw bag carries the recruiter-set `metadata` (Location
    // Type, Visa Sponsorship, …), `offices`, `first_published`, etc.
    return {
      title: j.title,
      sourceUrl: j.absolute_url,
      rawContent: parts.join("\n"),
      location: j.location?.name || undefined,
      department:
        j.departments
          ?.map((d) => d.name)
          .filter(Boolean)
          .join(", ") || undefined,
      attributes: rawAttrs(j),
    };
  });
  return { companyName: titleCaseSlug(slug), jobs };
}
// -- Application form questions ------------------------------------------
//
// There is no questions JSON endpoint. The obvious-looking
//   GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{jobId}/questions
// 404s — the apply form is a server-rendered embed page at
//   https://job-boards.greenhouse.io/embed/job_app?for={slug}&token={jobId}
// where custom questions render as labelled inputs and multi-choice groups
// as fieldsets. Two shapes to extract:
//   1. Per-field custom questions:
//      <label id="question_{ID}-label" for="question_{ID}">QUESTION TEXT</label>
//      <input|textarea|select ... aria-required="true|false" type="...">
//   2. Multi-choice / EEOC groups:
//      <legend class="label checkbox__description">QUESTION<!-- --><span class="required">*</span></legend>
//      <div class="checkbox__wrapper">...inputs...</div>
//
// Lever / Ashby's public posting APIs don't expose application form questions
// reliably — Lever scrapes the SSR apply HTML; Ashby uses an unauth GraphQL
// endpoint. See fetchLeverQuestions / fetchAshbyQuestions below.

async function fetchGreenhouseQuestions(
  jobSourceUrl: string,
  hints?: { greenhouseSlug?: string | null },
): Promise<ApplicationQuestionsEnvelope> {
  // Greenhouse public job URLs look like:
  //   https://job-boards.greenhouse.io/<slug>/jobs/<numericId>
  //   https://boards.greenhouse.io/<slug>/jobs/<numericId>
  // The API URL (absolute_url for the job board) follows the same shape.
  //
  // BUT: companies with a Greenhouse custom-domain integration (Databricks,
  // Stripe, CoreWeave, …) get an `absolute_url` like
  //   https://<company>.com/careers?gh_jid=<numericId>
  // from the boards-api response, and that's what lands in Job.sourceUrl. The
  // host doesn't match `greenhouse.io` and the redirect (when there is one)
  // stays on the company's domain — so we can't recover the slug from the URL
  // alone. The caller passes `hints.greenhouseSlug` (read off
  // Company.greenhouseSlug) for those cases; combined with the `gh_jid` query
  // param, we have everything we need to rebuild the embed URL.
  const canonical =
    jobSourceUrl.match(
      /^https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i,
    ) ??
    jobSourceUrl.match(
      /^https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)\/jobs\/(\d+)/i,
    );
  let slug: string;
  let jobId: string;
  if (canonical) {
    [, slug, jobId] = canonical;
  } else {
    const ghJid = extractGhJid(jobSourceUrl);
    const hintSlug = hints?.greenhouseSlug?.trim() || null;
    if (!ghJid || !hintSlug) {
      return {
        status: "error",
        error: `not a recognized greenhouse job url: ${jobSourceUrl}`,
        fetchedAt: new Date().toISOString(),
      };
    }
    slug = hintSlug;
    jobId = ghJid;
  }
  const url = `https://job-boards.greenhouse.io/embed/job_app?for=${slug}&token=${jobId}`;

  const res = await fetchText(url, {
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      // Use a normal-browser UA — the embed page sometimes 403s obvious bot UAs.
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
  const questions: ApplicationQuestion[] = [];
  // Greenhouse renders the optional cover-letter attachment as an
  // `id="cover_letter"` widget (mirroring the always-present `id="resume"`),
  // only when the board has it enabled. Detect it so the walkthrough draft
  // step doesn't generate a cover letter for forms that don't ask for one.
  const coverLetter = /id="cover_letter"/i.test(html);

  // Shape 1: per-field custom questions. The label id encodes the field id
  // so we can also detect the immediately-following element type without
  // ambiguity about which input the label refers to.
  const labelRe = /<label id="question_(\d+)-label"[^>]*>([\s\S]*?)<\/label>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = labelRe.exec(html)) !== null) {
    const qid = lm[1];
    const labelHtml = lm[2];
    const text = cleanGreenhouseLabel(labelHtml);
    if (!text) continue;
    const field = findGreenhouseField(html, qid);
    // A trailing "*" marker inside the label (any span shape — class="required",
    // aria-hidden, etc.) also indicates required, since some <select> wrappers
    // don't carry aria-required on the visible element.
    const required =
      (field?.required ?? false) ||
      /<span[^>]*>\s*\*\s*<\/span>/i.test(labelHtml);
    const q: ApplicationQuestion = { question: text };
    if (required) q.required = true;
    if (field?.type) q.type = field.type;
    questions.push(q);
  }

  // Shape 2: fieldset / legend multi-choice groups. We exclude
  // class="visually-hidden" — those are accessibility labels for standard
  // fields like Phone.
  const legendRe =
    /<legend\s+class="((?:(?!visually-hidden)[^"])*)"[^>]*>([\s\S]*?)<\/legend>/gi;
  let gm: RegExpExecArray | null;
  while ((gm = legendRe.exec(html)) !== null) {
    const text = cleanGreenhouseLabel(gm[2]);
    if (!text) continue;
    const requiredInLegend =
      /<span class="required"[^>]*>\s*\*\s*<\/span>/i.test(gm[2]);
    const after = html.slice(gm.index, gm.index + 1500);
    const requiredAttr = /aria-required="true"|required="required"/i.test(
      after,
    );
    const required = requiredInLegend || requiredAttr;
    const q: ApplicationQuestion = { question: text };
    if (required) q.required = true;
    if (/<input[^>]+type="checkbox"/i.test(after)) {
      q.type = /checkbox__wrapper/i.test(after) ? "multi_select" : "checkbox";
    } else if (/<input[^>]+type="radio"/i.test(after)) {
      q.type = "single_select";
    }
    questions.push(q);
  }

  if (questions.length === 0) {
    return {
      status: "empty",
      coverLetter,
      fetchedAt: new Date().toISOString(),
    };
  }
  return {
    status: "ok",
    questions,
    coverLetter,
    fetchedAt: new Date().toISOString(),
  };
}

function cleanGreenhouseLabel(raw: string): string | null {
  const stripped = decodeEntities(
    raw
      // Strip any inline span containing only a "*" — Greenhouse renders this
      // as <span class="required">*</span> in some templates and as
      // <span aria-hidden="true">*</span> in others.
      .replace(/<span[^>]*>\s*\*\s*<\/span>/gi, "")
      .replace(/<!--[^-]*-->/g, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    // Also drop a trailing "*" that wasn't wrapped in a span at all.
    .replace(/\s*\*\s*$/g, "")
    .trim();
  return stripped || null;
}

function findGreenhouseField(
  html: string,
  qid: string,
): { type?: string; required: boolean } | null {
  // Locate the input/textarea/select that carries id="question_{qid}".
  // Anchoring on the id avoids reading the next question's aria-required
  // attribute when a React-select wrapper bloats the distance from label
  // to input.
  const idAttr = `id="question_${qid}"`;
  const idx = html.indexOf(idAttr);
  if (idx < 0) return null;
  const tagStart = html.lastIndexOf("<", idx);
  if (tagStart < 0) return null;
  // The full opening tag ends at the first `>` after tagStart.
  const tagEnd = html.indexOf(">", idx);
  if (tagEnd < 0) return null;
  const tag = html.slice(tagStart, tagEnd + 1);
  let type: string | undefined;
  if (/^<textarea/i.test(tag)) type = "textarea";
  else if (/^<select/i.test(tag)) type = "select";
  else if (/^<input/i.test(tag)) {
    // Greenhouse renders dropdown / quick-select questions (Yes/No, "how did
    // you hear", work-auth, etc.) as a React-select combobox: an
    // `<input type="text">` carrying role="combobox" / aria-autocomplete="list"
    // / class="select__input". Without this check those single-select dropdowns
    // get reported as free "text" and the decider has to guess they're not
    // prose. Genuine free-text inputs use class="input input__single-line" with
    // no combobox role, so there's no false-positive risk.
    if (
      /\brole="combobox"/i.test(tag) ||
      /\baria-autocomplete="list"/i.test(tag) ||
      /class="[^"]*\bselect__input\b/i.test(tag)
    ) {
      type = "single_select";
    } else {
      const t = tag.match(/type="([^"]+)"/i);
      type = t ? t[1] : "text";
    }
  }
  const required =
    /aria-required="true"/i.test(tag) || /\srequired="required"/i.test(tag);
  return { type, required };
}

export const greenhouse: AtsProviderModule = {
  provider: "greenhouse",
  detect(url) {
    const m = url.match(GREENHOUSE_RE) ?? url.match(GREENHOUSE_API_RE);
    if (!m) return null;
    const slug = m[1];
    return {
      provider: "greenhouse",
      jsonUrl: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
      parse: (data) => parseGreenhouse(data, slug),
    };
  },
  matchesQuestions(url, hints) {
    return (
      GREENHOUSE_RE.test(url) ||
      GREENHOUSE_API_RE.test(url) ||
      Boolean(hints.greenhouseSlug && extractGhJid(url))
    );
  },
  fetchQuestions(url, hints) {
    return fetchGreenhouseQuestions(url, hints);
  },
};
