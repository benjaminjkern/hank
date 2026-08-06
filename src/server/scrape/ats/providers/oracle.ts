import { htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";

import { fetchText, rawAttrs, type AtsProviderModule } from "../shared";

import type { ScrapeResult, ScrapedJob } from "../../types";

const ORACLE_RE =
  /^https?:\/\/([a-z0-9-]+)\.fa\.([a-z0-9-]+)\.oraclecloud\.com\/hcmUI\/CandidateExperience\/(?:[a-z]{2}\/)?sites\/([^/?#]+)/i;
// -- Oracle Recruiting Cloud (ORC / Fusion HCM Candidate Experience) -------
//
// Career sites at {tenant}.fa.{region}.oraclecloud.com/hcmUI/CandidateExperience/
// {lang}/sites/{site}/requisitions, backed by the unauthenticated REST API at the
// same origin under /hcmRestApi/resources/latest:
//   list:   GET .../recruitingCEJobRequisitions?expand=requisitionList&finder=findReqs;siteNumber={site},limit=N,offset=M
//           → items[0].requisitionList[] (summaries) + items[0].TotalJobsCount
//   detail: GET .../recruitingCEJobRequisitionDetails?expand=all&finder=ById;Id="{reqId}",siteNumber={site}
//           → items[0].{ExternalDescriptionStr, ExternalResponsibilitiesStr, ExternalQualificationsStr, PrimaryLocation, ...}
// (This is modern Oracle ORC — the successor to the older Taleo product on
// taleo.net, which is a different, separately-shaped system.)
//
// Questions: the apply flow is hCaptcha- + login-gated; no public questions
// endpoint, so questions are unsupported.
const ORACLE_PAGE_LIMIT = 50;
const ORACLE_MAX_DETAIL_JOBS = 300;
const ORACLE_DETAIL_CONCURRENCY = 4;

const oracleRest = (tenant: string, region: string) =>
  `https://${tenant}.fa.${region}.oraclecloud.com/hcmRestApi/resources/latest`;

type OracleReqSummary = {
  Id?: string;
  Title?: string;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  PostedDate?: string;
  JobFamily?: string;
  JobFunction?: string;
  WorkplaceTypeCode?: string;
};
type OracleSearchItem = {
  TotalJobsCount?: number;
  requisitionList?: OracleReqSummary[];
};
type OracleListResponse = { items?: OracleSearchItem[] };
type OracleDetail = {
  Id?: string;
  Title?: string;
  ExternalDescriptionStr?: string;
  ExternalResponsibilitiesStr?: string;
  ExternalQualificationsStr?: string;
  CorporateDescriptionStr?: string;
  OrganizationDescriptionStr?: string;
  PrimaryLocation?: string;
  WorkplaceType?: string;
  JobSchedule?: string;
  Category?: string;
  ContractType?: string;
  [k: string]: unknown;
};
type OracleDetailResponse = { items?: OracleDetail[] };

function oracleLocation(d: {
  PrimaryLocation?: string;
  WorkplaceType?: string;
}): string | undefined {
  const base = (d.PrimaryLocation ?? "").trim();
  const wt = d.WorkplaceType;
  const suffix =
    wt && /remote/i.test(wt)
      ? "Remote"
      : wt && /hybrid/i.test(wt)
        ? "Hybrid"
        : null;
  const out = [base || null, suffix].filter(Boolean).join(" • ");
  return out || undefined;
}

async function fetchOracleDetail(
  tenant: string,
  region: string,
  site: string,
  req: OracleReqSummary,
): Promise<ScrapedJob | null> {
  const id = req.Id;
  if (!id) return null;
  // The ById finder wants the Id wrapped in (URL-encoded) double quotes.
  const url = `${oracleRest(tenant, region)}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${encodeURIComponent(id)}%22,siteNumber=${encodeURIComponent(site)}`;
  const res = await fetchText(url, { headers: { Accept: "application/json" } });
  let d: OracleDetail = {
    Id: id,
    Title: req.Title,
    PrimaryLocation: req.PrimaryLocation,
  };
  if (res.ok) {
    try {
      const parsed = JSON.parse(res.text) as OracleDetailResponse;
      if (parsed.items?.[0]) d = { ...d, ...parsed.items[0] };
    } catch {
      /* keep summary */
    }
  }
  const title = (d.Title ?? req.Title ?? "").trim();
  if (!title) return null;
  const location = oracleLocation(d);
  const sections = [
    d.ExternalDescriptionStr,
    d.ExternalResponsibilitiesStr,
    d.ExternalQualificationsStr,
    d.CorporateDescriptionStr,
  ]
    .map((s) => htmlToText(s ?? "").trim())
    .filter(Boolean);
  const parts: string[] = [title];
  const meta = [location, d.JobSchedule, d.Category]
    .filter(Boolean)
    .join(" • ");
  if (meta) parts.push(meta);
  if (sections.length) {
    parts.push("");
    parts.push(sections.join("\n\n"));
  }
  return {
    title,
    sourceUrl: `https://${tenant}.fa.${region}.oraclecloud.com/hcmUI/CandidateExperience/en/sites/${site}/job/${id}`,
    rawContent: parts.join("\n").trim(),
    location,
    department: d.Category || req.JobFamily || undefined,
    employmentType: d.JobSchedule || d.ContractType || undefined,
    // Skip the (large, HTML) description strings — they're in rawContent.
    attributes: rawAttrs(d, [
      "ExternalDescriptionStr",
      "ExternalResponsibilitiesStr",
      "ExternalQualificationsStr",
      "CorporateDescriptionStr",
      "OrganizationDescriptionStr",
      "ShortDescriptionStr",
      "InternalQualificationsStr",
      "InternalResponsibilitiesStr",
    ]),
  };
}

async function fetchAllOracle(
  tenant: string,
  region: string,
  site: string,
): Promise<ScrapeResult> {
  const reqs: OracleReqSummary[] = [];
  let total = 0;
  let bytes = 0;
  let snippet = "";
  let offset = 0;
  while (reqs.length < ORACLE_MAX_DETAIL_JOBS) {
    const url = `${oracleRest(tenant, region)}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${encodeURIComponent(site)},limit=${ORACLE_PAGE_LIMIT},offset=${offset}`;
    const res = await fetchText(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `oracle list ${res.error}` };
    bytes += res.text.length;
    if (!snippet) snippet = res.text.slice(0, 400);
    let parsed: OracleListResponse;
    try {
      parsed = JSON.parse(res.text) as OracleListResponse;
    } catch {
      return { ok: false, error: `oracle list ${url}: invalid JSON` };
    }
    const item = parsed.items?.[0];
    if (typeof item?.TotalJobsCount === "number") total = item.TotalJobsCount;
    const batch = item?.requisitionList ?? [];
    if (batch.length === 0) break;
    for (const r of batch) {
      if (reqs.length >= ORACLE_MAX_DETAIL_JOBS) break;
      reqs.push(r);
    }
    if (batch.length < ORACLE_PAGE_LIMIT) break;
    offset += ORACLE_PAGE_LIMIT;
  }
  const jobs: ScrapedJob[] = [];
  for (let i = 0; i < reqs.length; i += ORACLE_DETAIL_CONCURRENCY) {
    const chunk = reqs.slice(i, i + ORACLE_DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((r) => fetchOracleDetail(tenant, region, site, r)),
    );
    for (const s of settled)
      if (s.status === "fulfilled" && s.value) jobs.push(s.value);
  }
  const truncated = total > jobs.length;
  return {
    ok: true,
    data: {
      companyName: titleCaseSlug(tenant),
      jobs,
      diagnostics: {
        provider: "oracle",
        fetchedUrl: `${oracleRest(tenant, region)}/recruitingCEJobRequisitions`,
        pageLength: bytes,
        pageSnippet: snippet,
        ...(truncated ? { truncatedAt: jobs.length } : {}),
      },
    },
  };
}

export const oracle: AtsProviderModule = {
  provider: "oracle",
  hostFragments: ["oraclecloud.com"],
  // The apply flow is hCaptcha- + login-gated; no public questions endpoint, so
  // questions are unsupported.
  supportsQuestions: false,
  detect(url) {
    const m = url.match(ORACLE_RE);
    if (!m) return null;
    const [, tenant, region, site] = m;
    return {
      provider: "oracle",
      fetchedUrl: `https://${tenant}.fa.${region}.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions`,
      fetchAll: () => fetchAllOracle(tenant, region, site),
    };
  },
};
