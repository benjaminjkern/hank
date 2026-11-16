// The company detail page's payload — what the right panel and chat store
// render. Built by getFocusedCompanyView (server/views/getFocusedCompany.ts).

import type { ContactView } from "@/shared/views/contactView";

export type CompanyJobView = {
  jobId: string;
  jobInteractionId: string;
  title: string;
  sourceUrl: string | null;
  status: string;
  // Populated only when status=CLOSED. Mirrors the dashboard's
  // skipped-companies treatment: show the reason in the row, expose
  // closeNote as a hover tooltip.
  closeReason: string | null;
  closeNote: string | null;
  // Populated only when status=DEFERRED ("could apply, outranked for now").
  deferReason: string | null;
  deferNote: string | null;
  updatedAt: string;
  // Application date for an APPLIED job aging without a response (drives the
  // escalating pill color + "Applied …" caption); null otherwise.
  appliedAt: string | null;
  // When the role ended, for terminal rows: the CLOSED/REJECTED/WITHDRAWN event
  // date, or Job.closedAt for DELISTED (no event). Null for non-terminal rows.
  closedAt: string | null;
};

export type CompanyEventView = {
  id: string;
  type: string;
  occurredAt: string;
  notes: string | null;
  // Set on per-role rows (APPLIED/RESPONDED/…); null on batch-summary + status
  // rows (JOBS_CLOSED/SCRAPE_FOUND/SHORTLIST_RAN/PAUSED/…).
  jobId: string | null;
  jobTitle: string | null;
};

export type CompanyStatusName =
  | "NEW"
  | "READY"
  | "SHORTLISTING"
  | "APPLYING"
  | "IN_FLIGHT"
  | "IN_PROCESS"
  | "CAUGHT_UP"
  | "PAUSED"
  | "BLOCKED"
  | "CLOSED";
export type CompanyCloseReasonName =
  "NOT_A_MATCH" | "LOCATION_MISMATCH" | "OTHER";
export type CompanyPauseReasonName = "USER_PAUSED" | "OTHER";
export type CompanyBlockReasonName =
  "CANNOT_SCRAPE" | "AMBIGUOUS_NAME" | "NO_OWN_BOARD" | "AUTH_WALLED" | "OTHER";

export type FocusedCompanyView = {
  id: string;
  name: string;
  // The company's URL segment (/dashboard/<slug>). NOT NULL in the schema.
  slug: string;
  // Nullable while the add_to_watchlist URL hunter is still in flight or
  // ended with CANNOT_SCRAPE. UI renders a placeholder when null.
  sourceUrl: string | null;
  description: string | null;
  status: CompanyStatusName;
  closeReason: CompanyCloseReasonName | null;
  closeNote: string | null;
  // Populated when status=PAUSED (set aside for now; revivable).
  pauseReason: CompanyPauseReasonName | null;
  pauseNote: string | null;
  // Populated when status=BLOCKED (couldn't read the board; revivable).
  blockReason: CompanyBlockReasonName | null;
  blockNote: string | null;
  logoUrl: string;
  jobs: CompanyJobView[];
  recentEvents: CompanyEventView[];
  // Total count of non-excluded events at this company (independent of the
  // capped slice in recentEvents). Powers the "Show X more" expansion.
  recentEventsTotal: number;
  memoryNote: string | null;
  // People at this company, via Contact.companyId — recruiters, hiring
  // managers, anyone the user has talked to. Empty for most companies.
  contacts: ContactView[];
  lastActivityAt: string | null;
  lastScrapedJobsAt: string | null;
  // A shortlist proposal is on the table for this company — the only state in
  // which the board screen is worth opening, so the page links to it only then.
  shortlistBoardOpen: boolean;
};
