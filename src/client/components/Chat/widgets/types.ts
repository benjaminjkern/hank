// Widget payload type definitions + the marker shapes that get sent back
// to the server when the user submits. Each pipeline widget kind has both
// a server-to-client payload (rendered in the sticky bar) and a client-to-
// server submission shape (parsed by the runner's parseWidgetSubmission).

// ---- payload shapes (server → client) ---------------------------------

// add_more_companies — emitted once a discovery add has finished. Names what
// landed and asks the only question left: keep hunting, or move on.
export type AddMoreCompaniesPayload = {
  addedThisBatch: string[];
  // How many the user passed on this round. With `addedThisBatch` it answers
  // "did this round decide anything", which is what tells the server whether
  // "Done" is a real topic boundary worth wrapping the session on.
  passedCount: number;
};

// company_disambiguation — emitted by the watchlist-add runner when the URL
// hunter flagged a name collision: one queried name maps to ≥2 real
// companies. The user picks which one each ambiguous name means; the pick
// commits that company's verified board. All labels are plain English — no
// slugs/URLs/enums (the URL rides hidden in `chosenUrl`).
export type CompanyDisambiguationCandidate = {
  // The verified board URL committed when this candidate is chosen. Not shown.
  chosenUrl: string;
  canonicalName: string;
  shortDescription: string;
};

export type CompanyDisambiguationCompany = {
  // The unresolved stub (NEW, no sourceUrl) this pick resolves.
  companyId: string;
  // The original ambiguous name the user typed/picked ("Runway").
  name: string;
  candidates: CompanyDisambiguationCandidate[];
};

export type CompanyDisambiguationPayload = {
  companies: CompanyDisambiguationCompany[];
};

export type ConfirmReviveCompanyPayload = {
  companyId: string;
  companyName?: string;
  // Plain-English context for why the company was set aside, so the user can
  // decide whether to override (e.g. "I set it aside earlier because its open
  // roles were all sales / solutions-architect roles").
  reasoning: string;
};

export type ConfirmApplicationSubmitPayload = {
  jobId: string;
  jobTitle?: string;
  companyName?: string;
};

// next_job_picker — emitted by the company walkthrough once SCANNED jobs have
// been triaged. Replaces the silent auto-focus
// onto the stalest SHORTLISTED job: the user picks which job to walk through
// next from a list of SHORTLISTED + DEFERRED. Picking a DEFERRED row revives
// it (status → SHORTLISTED + defer fields cleared) and enters work_on_job.
// The "Done with this company" button wraps the company as CAUGHT_UP.
export type NextJobPickerShortlistedRow = {
  jobId: string;
  title: string;
  location: string | null;
  compensation: string | null;
};

export type NextJobPickerDeferredRow = {
  jobId: string;
  title: string;
  // Structured reason (JobDeferReason enum name) — kept as a string so the
  // client doesn't bind to the Prisma enum. Usually OUTRANKED.
  deferReason: string | null;
};

export type NextJobPickerPayload = {
  companyId: string;
  companyName: string;
  shortlisted: NextJobPickerShortlistedRow[];
  deferred: NextJobPickerDeferredRow[];
};

// next_company_picker — rendered between pipelines so the user has agency
// over which company / opportunity to engage next (replaces the silent
// auto-advance from the pre-overhaul runWhatsNext).
//
// Rows mirror NextOptionRow from src/server/entities/whatsNext.ts but kept
// as a separate type because (a) the client doesn't need to depend on the
// server Prisma enum imports and (b) the widget is the source of truth for
// what it accepts in its payload.
export type NextCompanyPickerCompanyRow = {
  kind: "company";
  id: string;
  name: string;
  logoUrl: string | null;
  sourceUrl: string | null;
  subtitle: string;
  // Keep the underlying status string so the widget can show a discreet
  // status pill or color-code without re-fetching. Free-form so we don't
  // bind the client to the Prisma enum.
  status: string;
};

export type NextCompanyPickerOpportunityRow = {
  kind: "opportunity";
  id: string;
  label: string;
  subtitle: string;
  status: string;
};

// A specific job surfaced as immediate on its own — an interview debrief /
// offer the user owes a move on, or a job-level deferral that's come due.
// Mirrors the "job" arm of NextOptionRow in whatsNext.ts. Picking it focuses
// the job and routes to the default flow (Hank fields the conversation).
export type NextCompanyPickerJobRow = {
  kind: "job";
  id: string; // jobId
  title: string;
  companyName: string | null;
  logoUrl: string | null;
  sourceUrl: string | null;
  subtitle: string;
  status: string;
};

export type NextCompanyPickerRow =
  | NextCompanyPickerCompanyRow
  | NextCompanyPickerOpportunityRow
  | NextCompanyPickerJobRow;

export type NextCompanyPickerPayload = {
  immediate: NextCompanyPickerRow[];
  // DEFERRED companies the user paused — revivable directly from the picker.
  // Renders between immediate and backlog. Optional so widget rows persisted
  // before this field existed still render (treat absent as []).
  deferred?: NextCompanyPickerRow[];
  backlog: NextCompanyPickerRow[];
  // True when all sections are empty. Widget renders the empty-state
  // variant: only an "Add companies to your watchlist" CTA, no list rows.
  empty: boolean;
};

// ---- submission shapes (client → server, embedded in chat marker) -----

// One resolved branch of a flagged name collision: the user picked
// which real company the ambiguous name maps to. Companies the user skipped are
// simply absent from `resolved`.
export type DisambiguationResolution = {
  companyId: string;
  chosenUrl: string;
  canonicalName: string;
  shortDescription: string;
};

export type WidgetSubmission =
  | { kind: "company_disambiguation"; resolved: DisambiguationResolution[] }
  // Keep hunting after an add landed ("yes" re-runs the search) or move on
  // ("no" hands off to what's next). `settled` is how many companies this round
  // decided, so the server can skip the session wrap on a round that changed
  // nothing.
  | { kind: "add_more_companies"; answer: "yes" | "no"; settled: number }
  | { kind: "confirm_revive_company"; companyId: string; answer: "yes" | "no" }
  | { kind: "confirm_application_submit"; jobId: string }
  // "Looks good to me" on a negotiation panel that has nothing outstanding —
  // settle it without spending a turn on Hank agreeing with his own proposal.
  // Submission-only: no widget renders this, the panel's own pill emits it, and
  // the server re-checks that nothing is outstanding before acting.
  | { kind: "commit_negotiation"; panel: "discovery" }
  | { kind: "commit_negotiation"; panel: "shortlist-board"; companyId: string }
  // Three branches for the next-company picker:
  //   - pick a company → walkthrough on that company (auto-bumps to ACTIVE
  //     if it was READY/NEW; both stay ACTIVE if there was already one).
  //   - pick an opportunity → walkthrough on that opportunity arm.
  //   - add_companies → default flow with a conversational "what are you
  //     looking for?" opener (Hank grows the list via find_companies /
  //     create_companies); APPLYING rows stay APPLYING for the next picker.
  | { kind: "next_company_picker"; choice: "company"; companyId: string }
  | {
      kind: "next_company_picker";
      choice: "opportunity";
      opportunityId: string;
    }
  // pick a job → focus it + default flow (interview debrief / offer / un-pause)
  | { kind: "next_company_picker"; choice: "job"; jobId: string }
  | { kind: "next_company_picker"; choice: "add_companies" }
  // Two branches for the next-job picker:
  //   - pick a job → enter work_on_job; DEFERRED rows are auto-revived to
  //     SHORTLISTED in the same transaction (deferReason/Note/Until cleared).
  //   - caught_up → mark the company CAUGHT_UP and emit the next-company
  //     picker on the following pass.
  | {
      kind: "next_job_picker";
      companyId: string;
      choice: "pick";
      jobId: string;
    }
  | {
      kind: "next_job_picker";
      companyId: string;
      choice: "caught_up";
    };

// ---- response-card display data (client → marker → client) ------------
//
// Display-only extras a widget submission embeds in its marker under `_view`
// so the chat can render a bespoke "you chose X" response card instead of
// the raw marker text. Server-side submission parsers manually pick the
// fields they need and ignore unknown keys, so `_view` rides along harmlessly
// and is never read by the runner. It exists purely so the response card
// survives a reload (the marker is the only persisted source — the live
// widget payload with titles/names is gone after dismissal).
//
// Only fields NOT already present in the submission go here; the card render
// model merges submission fields + `_view`. add_more_companies carries
// everything in the submission and passes no `_view`.
type WidgetResponseView =
  | { kind: "confirm_revive_company"; companyName: string }
  | {
      kind: "confirm_application_submit";
      jobTitle: string | null;
      companyName: string | null;
    }
  | {
      kind: "next_company_picker_company";
      name: string;
      logoUrl: string | null;
    }
  | { kind: "next_company_picker_opportunity"; label: string }
  | {
      kind: "next_company_picker_job";
      title: string;
      companyName: string | null;
      logoUrl: string | null;
    }
  | {
      kind: "next_job_picker_pick";
      jobTitle: string;
      bucket: "shortlisted" | "deferred";
    }
  | { kind: "next_job_picker_caught_up"; companyName: string };

const MARKER_PREFIX = "<!--widget-response:";
const MARKER_SUFFIX = "-->";

// Build a structured chat message with the marker prepended so the runner
// can parse the user's choice on the server. The visible label (after the
// marker) appears in the chat history as the user message (and is what the
// agent reads as context). The optional `view` blob carries display-only
// data for the chat-side response card — see WidgetResponseView.
export function buildWidgetSubmissionMessage(
  submission: WidgetSubmission,
  visibleLabel: string,
  view?: Omit<WidgetResponseView, "kind">,
): string {
  const payload = view ? { ...submission, _view: view } : submission;
  return `${MARKER_PREFIX}${JSON.stringify(payload)}${MARKER_SUFFIX}\n${visibleLabel}`;
}
