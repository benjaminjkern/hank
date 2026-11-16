import type { DashboardView as DashboardData } from "@/client/chatStore";
import { statusLabel } from "@/shared/statusColors";
import { relativeTime } from "@/shared/utils/date";

// ---------------------------------------------------------------------------
// Search / filter
//
// A single client-side filter over the already-loaded dashboard payload — no
// new fetch, no scrape. Typing narrows to a flat results view (companies /
// jobs / leads) that cuts across the triage buckets, since "find this thing"
// is orthogonal to "what's urgent". An empty box restores the normal bucketed
// dashboard. The "Track …" affordance at the bottom hands an unmatched name to
// Hank's existing watchlist-add flow (chat-first — no parallel add endpoint).
// ---------------------------------------------------------------------------

type CompanyHit = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  stateLabel: string;
};
type JobHit = {
  jobId: string;
  title: string;
  companyName: string | null;
  status: string;
  meta: string | null;
  appliedAt: string | null;
};
type LeadHit = { opportunityId: string; label: string; status: string };
export type SearchResults = {
  companies: CompanyHit[];
  jobs: JobHit[];
  leads: LeadHit[];
  total: number;
};

export const norm = (s: string) => s.normalize("NFKD").toLowerCase().trim();

export function buildSearchResults(
  data: DashboardData,
  rawQuery: string,
): SearchResults {
  const q = norm(rawQuery);
  const hit = (s: string | null | undefined) => !!s && norm(s).includes(q);

  // Companies span every bucket — searching should find one whatever its
  // status, so we sweep all four server-split lists, tagging each with a
  // friendly state label for the right-hand chip.
  const companies: CompanyHit[] = [];
  for (const c of data.companies) {
    if (hit(c.companyName))
      companies.push({ ...pickCompany(c), stateLabel: statusLabel(c.status) });
  }
  for (const c of data.closed ?? []) {
    if (hit(c.companyName))
      companies.push({ ...pickCompany(c), stateLabel: "Closed" });
  }
  for (const c of data.paused ?? []) {
    if (hit(c.companyName))
      companies.push({ ...pickCompany(c), stateLabel: "Paused" });
  }
  for (const c of data.blocked ?? []) {
    if (hit(c.companyName))
      companies.push({ ...pickCompany(c), stateLabel: "Blocked" });
  }

  // Jobs come from two places: a tracked company's roles and a lead's pitched
  // roles. Match on title OR the owning company name (so "stripe" surfaces
  // Stripe's roles too), then dedupe by jobId — a job can appear under both.
  const jobMap = new Map<string, JobHit>();
  for (const c of data.companies) {
    for (const i of c.jobInteractions) {
      if (hit(i.title) || hit(c.companyName)) {
        const appliedCaption =
          i.status === "APPLIED" && i.appliedAt
            ? `Applied ${relativeTime(i.appliedAt)}`
            : null;
        const meta = [
          appliedCaption,
          i.location,
          i.compensation,
          i.employmentType,
          i.department,
        ]
          .filter(Boolean)
          .join(" · ");
        if (!jobMap.has(i.jobId))
          jobMap.set(i.jobId, {
            jobId: i.jobId,
            title: i.title,
            companyName: c.companyName,
            status: i.status,
            meta: meta || null,
            appliedAt: i.appliedAt,
          });
      }
    }
  }
  for (const o of data.opportunities ?? []) {
    for (const j of o.jobs ?? []) {
      const co = j.companyDisplayName ?? o.label;
      if (hit(j.title) || hit(co)) {
        if (!jobMap.has(j.jobId))
          jobMap.set(j.jobId, {
            jobId: j.jobId,
            title: j.title,
            companyName: co,
            status: j.status,
            meta: null,
            // Opportunity-pitched roles don't carry an apply date in the
            // dashboard payload — no aging for these search hits.
            appliedAt: null,
          });
      }
    }
  }
  const jobs = [...jobMap.values()];

  const leads: LeadHit[] = [];
  for (const o of data.opportunities ?? []) {
    if (hit(o.label))
      leads.push({
        opportunityId: o.opportunityId,
        label: o.label,
        status: o.status,
      });
  }

  // Prefix matches first within each section, then alphabetical.
  const rank = (s: string) => (norm(s).startsWith(q) ? 0 : 1);
  companies.sort(
    (a, b) =>
      rank(a.companyName) - rank(b.companyName) ||
      a.companyName.localeCompare(b.companyName),
  );
  jobs.sort(
    (a, b) => rank(a.title) - rank(b.title) || a.title.localeCompare(b.title),
  );
  leads.sort(
    (a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label),
  );

  return {
    companies,
    jobs,
    leads,
    total: companies.length + jobs.length + leads.length,
  };
}

function pickCompany(c: {
  companyId: string;
  companyName: string;
  logoUrl: string;
}) {
  return {
    companyId: c.companyId,
    companyName: c.companyName,
    logoUrl: c.logoUrl,
  };
}
