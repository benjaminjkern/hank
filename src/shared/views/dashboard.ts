// The dashboard payload — every company on the user's watchlist, bucketed by
// status, plus their live inbound leads and the admin counters. Built by
// loadDashboard (server/views/dashboard.ts) for GET /api/dashboard.

import type {
  CompanyBlockReason,
  CompanyCloseReason,
  CompanyPauseReason,
  CompanyStatus,
  JobInteractionStatus,
  OpportunityStatus,
} from "@/shared/generated/enums";

export type DashboardCompany = {
  companyId: string;
  companyName: string;
  // Resolved logo URL, override or auto-derived.
  logoUrl: string;
  // Live statuses only — CLOSED / PAUSED / BLOCKED are split onto
  // `DashboardView.closed` / `.paused` / `.blocked`.
  status: Exclude<CompanyStatus, "CLOSED" | "PAUSED" | "BLOCKED">;
  // ISO timestamp of the most recent successful scrape, or null if the
  // company has never been scanned. Drives the empty-row label.
  lastScrapedJobsAt: string | null;
  // Count of jobs whose lastSeenAt matches lastScrapedJobsAt — i.e. jobs that
  // were on the careers page at the most recent scan. Excludes stale rows
  // from prior scans that have since fallen off. Zero when never scanned.
  recentJobCount: number;
  jobInteractions: Array<{
    jobInteractionId: string;
    jobId: string;
    title: string;
    sourceUrl: string | null;
    status: JobInteractionStatus;
    location: string | null;
    compensation: string | null;
    department: string | null;
    employmentType: string | null;
    lastEventType: string | null;
    lastEventAt: string | null;
    // When the user applied, for APPLIED jobs aging without a response (drives
    // the escalating pill color + "Applied …" caption). Derived from the latest
    // event when it's the APPLIED event — which it is for a job still sitting in
    // APPLIED, since a reply would have moved it to RESPONDED. Null otherwise.
    appliedAt: string | null;
  }>;
};

export type DashboardClosedCompany = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  closeReason: CompanyCloseReason | null;
  closeNote: string | null;
};

export type DashboardPausedCompany = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  pauseReason: CompanyPauseReason | null;
  pauseNote: string | null;
};

// Companies set aside because their board couldn't be read (BLOCKED). A
// technical set-aside, NOT a fit judgment — revivable (revive re-hunts). Its
// own dashboard list so the client renders a distinct "Blocked" bucket rather
// than lumping it with closed (red) or the active companies.
export type DashboardBlockedCompany = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  blockReason: CompanyBlockReason | null;
  blockNote: string | null;
};

export type DashboardOpportunityJob = {
  jobInteractionId: string;
  jobId: string;
  title: string;
  status: JobInteractionStatus; // includes PITCHED for opportunity-linked rows
  // Whichever is non-null: the joined Company.name (when linked to a real
  // Company) or the freeform Job.companyName the agent captured for an
  // unaffiliated pitch. UI consumers render whichever is set; null means we
  // genuinely don't know the company.
  companyDisplayName: string | null;
  companyId: string | null;
  // logoUrl is set when companyId is — drives the same logo chip used in the
  // main Company groups. Null for unaffiliated pitched jobs.
  logoUrl: string | null;
  // Application date for an APPLIED pitched role aging without a response
  // (drives the escalating pill color + "Applied …" caption); null otherwise.
  appliedAt: string | null;
  // When the role ended, for terminal rows. CLOSED/REJECTED roles are filtered
  // off the dashboard, so the only terminal status that reaches a lead row is
  // DELISTED, which dates off Job.closedAt — the global takedown date, and the
  // authority. Null for non-terminal rows.
  closedAt: string | null;
};

export type DashboardOpportunity = {
  opportunityId: string;
  label: string;
  // The statuses the dashboard surfaces — CLOSED leads roll off.
  status: Exclude<OpportunityStatus, "CLOSED">;
  nextStepAt: string | null;
  primaryContact: { name: string; agency: string | null } | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  // The pitched/discussed roles inside this lead — regular JobInteractions
  // linked via JobInteraction.opportunityId. Each row clicks into the normal
  // JobDetailView via viewJob(jobId).
  jobs: DashboardOpportunityJob[];
};

export type DashboardView = {
  companies: DashboardCompany[];
  closed: DashboardClosedCompany[];
  paused: DashboardPausedCompany[];
  blocked: DashboardBlockedCompany[];
  opportunities: DashboardOpportunity[];
  // Active job interactions across every live company.
  total: number;
  isAdmin: boolean;
  openAdminNoteCount: number;
  openDeletionRecCount: number;
};
