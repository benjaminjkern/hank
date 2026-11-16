// The opportunity (inbound lead) detail page's payload — what the right panel
// and chat store render. Built by getFocusedOpportunityView
// (server/views/getFocusedOpportunity.ts).

import type { ContactView } from "@/shared/views/contactView";

export type OpportunityStatusName =
  "OPEN" | "SCREENING" | "AWAITING" | "CLOSED";

// A pitched role inside an Opportunity, surfaced as a regular JobInteraction
// linked back via JobInteraction.opportunityId — there is no separate
// opportunity-role lifecycle; it's the JobInteraction pipeline starting at
// PITCHED.
export type OpportunityJobView = {
  jobInteractionId: string;
  jobId: string;
  title: string;
  // companyId is set once linked to a real Company on the watchlist; companyName
  // is the human-readable fallback when companyId is null (e.g. "undisclosed
  // fintech"). UI consumers render whichever is non-null.
  companyId: string | null;
  companyName: string | null;
  status: string; // JobInteractionStatus, including PITCHED
  closeReason: string | null;
  closeNote: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  // Application date for an APPLIED role aging without a response (drives the
  // escalating pill color + "Applied …" caption); null otherwise.
  appliedAt: string | null;
  // When the role ended, for terminal rows: the CLOSED/REJECTED/WITHDRAWN event
  // date, or Job.closedAt for DELISTED. Null for non-terminal rows.
  closedAt: string | null;
};

export type OpportunityEventView = {
  id: string;
  type: string;
  occurredAt: string;
  notes: string | null;
};

export type FocusedOpportunityView = {
  id: string;
  // The lead's URL segment (/dashboard/<slug>). Null on rows minted before
  // slugs; the URL falls back to the cuid.
  slug: string | null;
  label: string;
  status: OpportunityStatusName;
  nextStepAt: string | null;
  notes: string | null;
  closedReason: string | null;
  // The "trigger" — when the inbound was triggered by an existing real-company
  // JobInteraction (e.g. user applied to Acme direct, then an Acme recruiter
  // spun off other roles). Null for agency-posting inbounds.
  sourceJobInteraction: {
    jobId: string;
    title: string;
    companyId: string | null;
    companyName: string | null;
  } | null;
  primaryContact: ContactView | null;
  contacts: ContactView[];
  // The pitched/discussed roles within this lead — real JobInteractions linked
  // via JobInteraction.opportunityId. Always present (may be empty for freshly-
  // created leads with no roles attached yet).
  jobInteractions: OpportunityJobView[];
  events: OpportunityEventView[];
  memoryNote: string | null;
  createdAt: string;
  updatedAt: string;
};
