// The job detail page's payload — what the right panel and chat store render.
// Built by getFocusedJobView (server/views/getFocusedJob.ts).

import type { ShortAnswer } from "@/shared/applicationDrafts";
import type { ApplicationQuestionsEnvelope } from "@/shared/applicationQuestions";

export type EventView = {
  id: string;
  type: string;
  occurredAt: string;
  notes: string | null;
};

export type FocusedJobView = {
  id: string;
  // The role's URL segment (/dashboard/<company>/<slug>). Null on rows minted
  // before slugs; the URL falls back to the cuid.
  slug: string | null;
  title: string;
  sourceUrl: string | null;
  description: string | null; // Job.rawContent — full posting text
  // Structured metadata pulled from the ATS API (Greenhouse / Lever / Ashby)
  // or extracted by the LLM scrape. Null when the source didn't provide it.
  // Rendered as a muted bullet-separated row in the job-detail header so the
  // user can see comp / location at a glance without scrolling the posting.
  location: string | null;
  department: string | null;
  compensation: string | null;
  employmentType: string | null;
  // Greenhouse-scraped application form, lazy-fetched on first ensureApplicationForm.
  // null = not attempted yet; other states = see ApplicationQuestionsEnvelope.
  applicationQuestions: ApplicationQuestionsEnvelope | null;
  // logoUrl is the resolved company logo (override or auto-derived) so the
  // job-detail header can render the same chip the dashboard / company page
  // show — keeps brand identity visible while drilling into a job.
  //
  // null when this Job is an unaffiliated pitched role (no company on the
  // watchlist yet). In that case `companyNameFallback` carries the human-
  // readable name the agent captured from the recruiter.
  company: { id: string; slug: string; name: string; logoUrl: string } | null;
  companyNameFallback: string | null;
  // The role's place in an open shortlist round at its company, so the page can
  // offer the same three marks the board does and a way back to the rest of it.
  // Null when no round is open — reading a role between rounds is just reading.
  //
  // It exists because the page is where the deciding actually happens: the board
  // is a summary, and the user clicks in precisely when the summary isn't enough
  // to mark on. Sending them back to the board to record what they just decided
  // is the round trip this removes.
  board: {
    // PICK / BORDERLINE / PASS — the live stance (the user's if they've moved
    // it, else Hank's), matching what the board row shows.
    verdict: string | null;
    // False for a row the round can't move — the same `isStanceable` gate the
    // board applies, so the two surfaces can't disagree about what's editable.
    markable: boolean;
    // Whether the automatic filtering closed it rather than anyone judging it,
    // which changes what the two unset marks mean.
    filtered: boolean;
  } | null;
  jobInteraction: {
    status: string;
    // Populated only when status=CLOSED. Mirrors the company-page
    // skipped-rows treatment: render a banner under the header with the
    // reason + freeform note.
    closeReason: string | null;
    closeNote: string | null;
    // Populated only when status=DEFERRED ("could apply, outranked for now").
    deferReason: string | null;
    deferNote: string | null;
    // Populated for APPLIED rows (and onwards). Null for pre-feature APPLIED
    // rows and for any status before APPLIED. RECRUITER / REFERRAL render as
    // a small caption next to the status pill; DIRECT is implicit (no chip).
    applyChannel: "DIRECT" | "RECRUITER" | "REFERRAL" | null;
    // Application date for an APPLIED job aging without a response (drives the
    // escalating pill color + "Applied …" caption); null otherwise.
    appliedAt: string | null;
    // When the role ended, for terminal rows: the CLOSED/REJECTED/WITHDRAWN
    // event date, or Job.closedAt for DELISTED. Null for non-terminal rows.
    closedAt: string | null;
    // Set when this JobInteraction was created or attached via an inbound
    // Opportunity (a recruiter pitch / referral conversation). Drives the
    // "← Pitched via <lead label>" chip on the JobDetailView — clicking it
    // jumps back to the lead. Null for scan-flow / referral-direct jobs.
    opportunity: { id: string; label: string } | null;
    coverLetter: string | null;
    shortAnswers: ShortAnswer[] | null;
    // "Used" stamps (ISO) — non-null once the user copied/edited the artifact.
    // null = agent draft the user hasn't touched. Drives whether the reuse
    // switch is offered (an unused draft doesn't feed drafting regardless).
    // "Reuse when drafting" toggles (tri-state). null ⇒ derive from
    // used-state; true/false ⇒ explicit opt-in/out. shortAnswersReuse is the
    // parallel array (null index ⇒ derive that answer from its used-state).
    coverLetterReuse: boolean | null;
    shortAnswersReuse: (boolean | null)[] | null;
    events: EventView[];
  };
};
