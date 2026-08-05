import { htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type { ScrapeResult, ScrapedJob } from "../../types";

const RIPPLING_RE = /^https?:\/\/ats\.rippling\.com\/([^/?#]+)\/jobs/i;
// A single Rippling job URL is ats.rippling.com/{slug}/jobs/{uuid} — questions
// are login-gated, so there's no job-level fetcher that needs to parse it.
// -- Rippling -------------------------------------------------------------
//
// ATS boards at ats.rippling.com/{slug}/jobs, backed by the public platform API:
//   list:   GET api.rippling.com/platform/api/ats/v1/board/{slug}/jobs      (array)
//   detail: GET api.rippling.com/platform/api/ats/v1/board/{slug}/jobs/{uuid}
// The list omits the body (it's in detail.description.{company,role}), so we
// fan-out detail fetches (capped + concurrency-limited).
//
// Questions: custom application questions live in the apply-form config behind
// the SPA; the detail exposes only an eeocQuestionnaireEnabled flag and no public
// questions endpoint, so questions are unsupported.
const RIPPLING_MAX_DETAIL_JOBS = 100;
const RIPPLING_DETAIL_CONCURRENCY = 5;

type RipplingLocationObj = {
  name?: string;
  country?: string;
  city?: string;
  state?: string;
  workplaceType?: string;
};
// The list's `locations` are objects; the detail's `workLocations` are plain
// strings ("Remote (United States)"). Handle both shapes.
type RipplingLocationEntry = string | RipplingLocationObj;
type RipplingListJob = {
  uuid?: string;
  name?: string;
  department?: { name?: string };
  locations?: RipplingLocationEntry[];
  url?: string;
  [k: string]: unknown;
};
type RipplingDetail = RipplingListJob & {
  description?: { company?: string; role?: string };
  workLocations?: RipplingLocationEntry[];
  employmentType?: { label?: string; id?: string };
  companyName?: string;
};

// Locations are dual-shape: the list endpoint returns location objects, the
// detail endpoint returns bare strings — handle both.
function ripplingLocation(locs?: RipplingLocationEntry[]): string | undefined {
  if (!locs?.length) return undefined;
  const l = locs[0];
  const base =
    typeof l === "string"
      ? l.trim()
      : (
          l.name || [l.city, l.state, l.country].filter(Boolean).join(", ")
        ).trim();
  const wt = typeof l === "string" ? undefined : l.workplaceType;
  const suffix =
    wt && /remote/i.test(wt)
      ? "Remote"
      : wt && /hybrid/i.test(wt)
        ? "Hybrid"
        : null;
  // `name` / the string often already reads "Remote (United States)" — don't double up.
  if (suffix && base && !new RegExp(suffix, "i").test(base))
    return `${base} • ${suffix}`;
  return base || suffix || undefined;
}

// employmentType: { label: "SALARIED_FT", id: "Salaried, full-time" } — `id` is
// the human-readable label here (Rippling's field naming is inverted).
function ripplingEmploymentType(d: RipplingDetail): string | undefined {
  return d.employmentType?.id || d.employmentType?.label || undefined;
}

async function fetchRipplingDetail(
  slug: string,
  job: RipplingListJob,
): Promise<ScrapedJob | null> {
  const uuid = job.uuid;
  const title = (job.name ?? "").trim();
  if (!uuid || !title) return null;
  const res = await fetchText(
    `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs/${uuid}`,
    { headers: { Accept: "application/json" } },
  );
  let d: RipplingDetail = job;
  if (res.ok) {
    try {
      d = { ...job, ...(JSON.parse(res.text) as RipplingDetail) };
    } catch {
      /* keep summary */
    }
  }
  const location = ripplingLocation(d.workLocations || d.locations);
  const company = htmlToText(d.description?.company ?? "");
  const role = htmlToText(d.description?.role ?? "");
  const parts: string[] = [title];
  const meta = [location, ripplingEmploymentType(d), d.department?.name]
    .filter(Boolean)
    .join(" • ");
  if (meta) parts.push(meta);
  if (role || company) {
    parts.push("");
    if (role) parts.push(role);
    if (company) parts.push(company);
  }
  return {
    title,
    sourceUrl: d.url || `https://ats.rippling.com/${slug}/jobs/${uuid}`,
    rawContent: parts.join("\n").trim(),
    location,
    department: d.department?.name || undefined,
    employmentType: ripplingEmploymentType(d),
    attributes: rawAttrs(d, ["description", "board"]),
  };
}

async function fetchAllRippling(slug: string): Promise<ScrapeResult> {
  const listUrl = `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`;
  const res = await fetchText(listUrl, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, error: `rippling list ${res.error}` };
  let list: RipplingListJob[];
  try {
    list = JSON.parse(res.text) as RipplingListJob[];
  } catch {
    return { ok: false, error: `rippling list ${listUrl}: invalid JSON` };
  }
  if (!Array.isArray(list))
    return { ok: false, error: `rippling list ${listUrl}: unexpected shape` };
  const capped = list.slice(0, RIPPLING_MAX_DETAIL_JOBS);
  const jobs: ScrapedJob[] = [];
  for (let i = 0; i < capped.length; i += RIPPLING_DETAIL_CONCURRENCY) {
    const chunk = capped.slice(i, i + RIPPLING_DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((j) => fetchRipplingDetail(slug, j)),
    );
    for (const s of settled)
      if (s.status === "fulfilled" && s.value) jobs.push(s.value);
  }
  const truncated = list.length > jobs.length;
  return {
    ok: true,
    data: {
      companyName: titleCaseSlug(
        slug.replace(/-?job-?board$/i, "").replace(/-+$/, ""),
      ),
      jobs,
      diagnostics: {
        provider: "rippling",
        fetchedUrl: listUrl,
        pageLength: res.text.length,
        pageSnippet: res.text.slice(0, 400),
        ...(truncated ? { truncatedAt: jobs.length } : {}),
      },
    },
  };
}

export const rippling: AtsProviderModule = {
  provider: "rippling",
  hostFragments: ["ats.rippling.com"],
  // Custom application questions live in the apply-form config behind the SPA;
  // the detail exposes only an eeocQuestionnaireEnabled flag and no public
  // questions endpoint, so questions are unsupported.
  supportsQuestions: false,
  detect(url) {
    const m = url.match(RIPPLING_RE);
    if (!m) return null;
    const slug = m[1];
    return {
      provider: "rippling",
      fetchedUrl: `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`,
      fetchAll: () => fetchAllRippling(slug),
    };
  },
};
