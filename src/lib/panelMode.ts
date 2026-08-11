// The right panel's view vocabulary. Lives apart from chatStore so server
// modules (views/panelView.ts, the shell pages) can import it without pulling
// in the "use client" zustand store.

export type PanelMode =
  | "dashboard"
  | "company-context"
  | "job-detail"
  | "opportunity-detail"
  // Per-company shortlist board — every role considered, tiered, editable
  // while a negotiation is open. Driven by the agent's board show events and
  // user navigation (dashboard / company page links).
  | "shortlist-board"
  // Companies the search has proposed and the user is marking up. Non-entity
  // scoped (like documents/analytics) but agent-opened: find_companies puts it
  // on screen, and marks relay to Hank on the next message.
  | "discovery"
  // One job's application: every item the form asks for, editable, with the
  // submit action. Reached from the job page, a chat link, or Hank surfacing it
  // when he finishes drafting.
  | "application"
  // Non-entity-scoped, user-navigable view (like dashboard). Shows the user's
  // documents (profile / resume / frequent questions / used answers / uploaded
  // files). Hank never puts it on screen — no show event resolves to it.
  | "documents"
  // Non-entity-scoped analytics view (like documents): activity-by-day grid +
  // application-status funnel. Self-fetching from /api/analytics.
  | "analytics";

// The Documents view is itself a tiny router: an index of cards, each opening
// its own sub-page (so the page reads short instead of one long scroll).
export type DocumentsSubPage =
  "index" | "resume" | "profile" | "frequent" | "artifacts" | "files";

// One list, so the URL segment, the breadcrumb leaf and the sub-page heading
// can't drift apart. `index` is absent — it's the sub-page with no segment and
// no leaf crumb, and its heading is the Documents page title itself.
const SUB_PAGE_LABELS: Record<Exclude<DocumentsSubPage, "index">, string> = {
  resume: "Resume",
  profile: "Profile",
  frequent: "Frequent questions",
  artifacts: "Cover letters & short answers",
  files: "Uploaded files",
};

export function documentsSubPageLabel(subPage: DocumentsSubPage): string {
  return subPage === "index" ? "Documents" : SUB_PAGE_LABELS[subPage];
}

export function isDocumentsSubPage(value: string): value is DocumentsSubPage {
  return value === "index" || value in SUB_PAGE_LABELS;
}
