import { htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type { ScrapeResult, ScrapedJob } from "../../types";

const EIGHTFOLD_RE = /^https?:\/\/([a-z0-9-]+)\.eightfold\.ai(\/|$)/i;
// -- Eightfold ------------------------------------------------------------
//
// Multi-tenant discovery platform at {tenant}.eightfold.ai. The unauthenticated
// JSON API (the Host subdomain is the tenant; the `domain` query param can be
// omitted) gives:
//   list:   GET {tenant}.eightfold.ai/api/apply/v2/jobs?start=N&num=M&sort_by=relevance
//   detail: GET {tenant}.eightfold.ai/api/apply/v2/jobs/{positionId}   (full job_description)
// The list omits job_description, so we page summaries then fan-out detail
// fetches (capped + concurrency-limited).
//
// Questions: Eightfold is a discovery layer — applications redirect OUT to the
// company's underlying ATS (SuccessFactors/Workday/etc., per apply_redirect_url),
// and no Eightfold-native questions endpoint exists, so questions are unsupported.
const EIGHTFOLD_PAGE_LIMIT = 50;
const EIGHTFOLD_MAX_DETAIL_JOBS = 100;
const EIGHTFOLD_DETAIL_CONCURRENCY = 5;

type EightfoldPosition = {
  id?: number | string;
  name?: string;
  location?: string;
  locations?: string[];
  department?: string;
  business_unit?: string;
  work_location_option?: string;
  display_job_id?: string;
  canonicalPositionUrl?: string;
  job_description?: string;
  [k: string]: unknown;
};
type EightfoldListResponse = {
  count?: number;
  positions?: EightfoldPosition[];
};

function eightfoldLocation(p: EightfoldPosition): string | undefined {
  const raw =
    p.location || (Array.isArray(p.locations) ? p.locations[0] : "") || "";
  // "Berlin,Berlin,Germany" → dedupe consecutive segments, join ", "
  const parts: string[] = [];
  for (const seg of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (parts[parts.length - 1] !== seg) parts.push(seg);
  }
  const base = parts.join(", ");
  const wl = p.work_location_option;
  const suffix =
    wl && /remote/i.test(wl)
      ? "Remote"
      : wl && /hybrid/i.test(wl)
        ? "Hybrid"
        : null;
  const out = [base || null, suffix].filter(Boolean).join(" • ");
  return out || undefined;
}

function eightfoldToScraped(
  tenant: string,
  p: EightfoldPosition,
): ScrapedJob | null {
  const title = (p.name ?? "").trim();
  const pid = p.id != null ? String(p.id) : "";
  if (!title || !pid) return null;
  const location = eightfoldLocation(p);
  const body = htmlToText(p.job_description ?? "");
  const parts: string[] = [title];
  const meta = [location, p.business_unit, p.department]
    .filter(Boolean)
    .join(" • ");
  if (meta) parts.push(meta);
  if (body) {
    parts.push("");
    parts.push(body);
  }
  return {
    title,
    sourceUrl:
      p.canonicalPositionUrl ||
      `https://${tenant}.eightfold.ai/careers?pid=${pid}`,
    rawContent: parts.join("\n").trim(),
    location,
    department: p.department || p.business_unit || undefined,
    attributes: rawAttrs(p, ["job_description", "locations"]),
  };
}

async function fetchEightfoldDetail(
  tenant: string,
  p: EightfoldPosition,
): Promise<ScrapedJob | null> {
  const pid = p.id != null ? String(p.id) : "";
  if (!pid) return null;
  const res = await fetchText(
    `https://${tenant}.eightfold.ai/api/apply/v2/jobs/${pid}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  let full: EightfoldPosition = p;
  if (res.ok) {
    try {
      full = { ...p, ...(JSON.parse(res.text) as EightfoldPosition) };
    } catch {
      /* keep summary */
    }
  }
  return eightfoldToScraped(tenant, full);
}

async function fetchAllEightfold(tenant: string): Promise<ScrapeResult> {
  const positions: EightfoldPosition[] = [];
  let count = 0;
  let bytes = 0;
  let snippet = "";
  let start = 0;
  while (positions.length < EIGHTFOLD_MAX_DETAIL_JOBS) {
    const url = `https://${tenant}.eightfold.ai/api/apply/v2/jobs?start=${start}&num=${EIGHTFOLD_PAGE_LIMIT}&sort_by=relevance`;
    const res = await fetchText(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `eightfold list ${res.error}` };
    bytes += res.text.length;
    if (!snippet) snippet = res.text.slice(0, 400);
    let parsed: EightfoldListResponse;
    try {
      parsed = JSON.parse(res.text) as EightfoldListResponse;
    } catch {
      return { ok: false, error: `eightfold list ${url}: invalid JSON` };
    }
    if (typeof parsed.count === "number") count = parsed.count;
    const batch = Array.isArray(parsed.positions) ? parsed.positions : [];
    if (batch.length === 0) break;
    for (const p of batch) {
      if (positions.length >= EIGHTFOLD_MAX_DETAIL_JOBS) break;
      positions.push(p);
    }
    if (batch.length < EIGHTFOLD_PAGE_LIMIT) break;
    start += EIGHTFOLD_PAGE_LIMIT;
  }
  const jobs: ScrapedJob[] = [];
  for (let i = 0; i < positions.length; i += EIGHTFOLD_DETAIL_CONCURRENCY) {
    const chunk = positions.slice(i, i + EIGHTFOLD_DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((p) => fetchEightfoldDetail(tenant, p)),
    );
    for (const s of settled)
      if (s.status === "fulfilled" && s.value) jobs.push(s.value);
  }
  const truncated = count > jobs.length;
  return {
    ok: true,
    data: {
      companyName: titleCaseSlug(tenant),
      jobs,
      diagnostics: {
        provider: "eightfold",
        fetchedUrl: `https://${tenant}.eightfold.ai/api/apply/v2/jobs`,
        pageLength: bytes,
        pageSnippet: snippet,
        ...(truncated ? { truncatedAt: jobs.length } : {}),
      },
    },
  };
}

export const eightfold: AtsProviderModule = {
  provider: "eightfold",
  hostFragments: ["eightfold.ai"],
  // Eightfold is a discovery layer — applications redirect OUT to the company's
  // underlying ATS (SuccessFactors/Workday/etc.), and no Eightfold-native
  // questions endpoint exists, so questions are unsupported.
  supportsQuestions: false,
  detect(url) {
    const m = url.match(EIGHTFOLD_RE);
    if (!m) return null;
    const tenant = m[1];
    return {
      provider: "eightfold",
      fetchedUrl: `https://${tenant}.eightfold.ai/api/apply/v2/jobs`,
      fetchAll: () => fetchAllEightfold(tenant),
    };
  },
};
