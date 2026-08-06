import { decodeEntities, htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { scrapeFetchSignal } from "../../scrapeSignal";
import { rawAttrs, type AtsProviderModule } from "../shared";

import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
  ScrapedCompany,
  ScrapedJob,
} from "../../types";

const LEVER_RE = /^https?:\/\/jobs\.lever\.co\/([^/?#]+)/i;
const LEVER_API_RE = /^https?:\/\/api\.lever\.co\/v0\/postings\/([^/?#]+)/i;
// -- Lever ----------------------------------------------------------------

type LvJob = {
  id: string;
  text: string;
  hostedUrl: string;
  description?: string;
  descriptionPlain?: string;
  categories?: {
    team?: string;
    location?: string;
    commitment?: string;
    allLocations?: string[];
  };
  lists?: Array<{ text?: string; content?: string }>;
  additional?: string;
  additionalPlain?: string;
  workplaceType?: string;
  country?: string;
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
    interval?: string;
  };
  salaryDescriptionPlain?: string;
};

// Lever exposes structured pay in `salaryRange`. Prefer it; fall back to the
// human `salaryDescriptionPlain` blurb.
function leverComp(j: LvJob): string | undefined {
  const r = j.salaryRange;
  if (r && (typeof r.min === "number" || typeof r.max === "number")) {
    const cur = r.currency || "USD";
    const sym = cur === "USD" ? "$" : `${cur} `;
    const fmt = (n: number) => `${sym}${Math.round(n).toLocaleString("en-US")}`;
    const range =
      typeof r.min === "number" && typeof r.max === "number"
        ? `${fmt(r.min)}–${fmt(r.max)}`
        : typeof r.min === "number"
          ? `${fmt(r.min)}+`
          : `up to ${fmt(r.max as number)}`;
    return range + (/hour/i.test(r.interval || "") ? "/hr" : "");
  }
  return j.salaryDescriptionPlain?.trim().slice(0, 200) || undefined;
}

function parseLever(data: unknown, slug: string): ScrapedCompany {
  if (!Array.isArray(data)) throw new Error("lever: unexpected shape");
  const jobs: ScrapedJob[] = (data as LvJob[]).map((j) => {
    const compensation = leverComp(j);
    const parts: string[] = [];
    parts.push(j.text);
    if (j.categories) {
      const cat = [
        j.categories.team,
        j.categories.location,
        j.categories.commitment,
      ]
        .filter(Boolean)
        .join(" • ");
      if (cat) parts.push(cat);
    }
    if (compensation) parts.push(`Compensation: ${compensation}`);
    parts.push("");
    parts.push(j.descriptionPlain ?? htmlToText(j.description ?? ""));
    if (Array.isArray(j.lists)) {
      for (const l of j.lists) {
        if (l.text) parts.push("", l.text);
        if (l.content) parts.push(htmlToText(l.content));
      }
    }
    if (j.additionalPlain ?? j.additional) {
      parts.push("");
      parts.push(j.additionalPlain ?? htmlToText(j.additional ?? ""));
    }
    return {
      title: j.text,
      sourceUrl: j.hostedUrl,
      rawContent: parts.join("\n"),
      location: j.categories?.location || undefined,
      department: j.categories?.team || undefined,
      employmentType: j.categories?.commitment || undefined,
      compensation,
      // categories holds {team,location,commitment,allLocations}; workplaceType,
      // country, createdAt (posting date), salaryRange all land here raw.
      attributes: rawAttrs(j),
    };
  });
  return { companyName: titleCaseSlug(slug), jobs };
}
// -- Lever ----------------------------------------------------------------
//
// Lever's hosted apply page at jobs.lever.co/<slug>/<jobId>/apply is
// server-rendered HTML. Each custom question "card" is embedded as JSON in a
// hidden <input name="cards[<uuid>][baseTemplate]" value="<HTML-encoded JSON>">,
// which is way cleaner than scraping the rendered DOM. Field types Lever
// emits: text, textarea, dropdown, multiple-choice, multiple-select,
// file-upload. We pass them through unmodified.

const LEVER_JOB_RE =
  /^https?:\/\/jobs\.lever\.co\/([^/?#]+)\/([a-z0-9-]{20,})/i;

type LeverCardField = {
  type?: string;
  text?: string;
  required?: boolean;
};
type LeverCard = {
  text?: string;
  fields?: LeverCardField[];
};

async function fetchLeverQuestions(
  jobSourceUrl: string,
): Promise<ApplicationQuestionsEnvelope> {
  const m = jobSourceUrl.match(LEVER_JOB_RE);
  if (!m) {
    return {
      status: "error",
      error: `not a recognized lever job url: ${jobSourceUrl}`,
      fetchedAt: new Date().toISOString(),
    };
  }
  const [, slug, jobId] = m;
  const url = `https://jobs.lever.co/${slug}/${jobId}/apply`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "text/html", "User-Agent": "HankBot/0.1" },
      redirect: "follow",
      signal: scrapeFetchSignal(20_000),
    });
    if (!res.ok) {
      return {
        status: "error",
        error: `${res.status} ${res.statusText}`,
        fetchedAt: new Date().toISOString(),
      };
    }
    const html = await res.text();
    const cardInputs = html.match(
      /<input[^>]+name="cards\[[^"]+\]\[baseTemplate\]"[^>]*>/g,
    );
    if (!cardInputs?.length) {
      return { status: "empty", fetchedAt: new Date().toISOString() };
    }

    const questions: ApplicationQuestion[] = [];
    for (const inputTag of cardInputs) {
      const valueMatch = inputTag.match(/value="([^"]*)"/);
      if (!valueMatch) continue;
      let card: LeverCard;
      try {
        card = JSON.parse(decodeEntities(valueMatch[1])) as LeverCard;
      } catch {
        continue;
      }
      // Lever surfaces internal-only recruiter cards in the same HTML the
      // applicant sees. Skip them — they're not part of the applicant form.
      if (card.text && /\(internal only\)/i.test(card.text)) continue;
      for (const f of card.fields ?? []) {
        const text = decodeEntities(f.text ?? "").trim();
        if (!text) continue;
        const q: ApplicationQuestion = { question: text };
        if (f.required) q.required = true;
        if (f.type) q.type = f.type;
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

export const lever: AtsProviderModule = {
  provider: "lever",
  hostFragments: ["lever.co"],
  supportsQuestions: true,
  detect(url) {
    const m = url.match(LEVER_RE) ?? url.match(LEVER_API_RE);
    if (!m) return null;
    const slug = m[1];
    return {
      provider: "lever",
      jsonUrl: `https://api.lever.co/v0/postings/${slug}?mode=json`,
      parse: (data) => parseLever(data, slug),
    };
  },
  matchesQuestions(url) {
    return LEVER_RE.test(url) || LEVER_API_RE.test(url);
  },
  fetchQuestions(url) {
    return fetchLeverQuestions(url);
  },
};
