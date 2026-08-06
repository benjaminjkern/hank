// The right panel's address: the URL a panel state writes, and the panel state
// a URL names. Pure and I/O-free on purpose — the RSC shell parses the incoming
// path with the same code the client writes back, so the two can't drift.
//
// The grammar mirrors the breadcrumb the panel already renders, lowercased,
// with entity slugs for the names:
//
//   /                                        chat only, panel stowed
//   /dashboard                               dashboard, panel open
//   /dashboard/documents[/<sub-page>]        documents
//   /dashboard/analytics                     analytics
//   /dashboard/<company>                     company page
//   /dashboard/<company>/shortlist           shortlist board
//   /dashboard/<company>/<job>               job page
//   /dashboard/<company>/<job>/application   application page
//   /dashboard/<lead>                        opportunity page
//
// `/` and `/dashboard` name the same MODE and differ only in whether the panel
// is open: the app is chat-first, so arriving at the root shouldn't fling a
// dashboard open, but "show me the dashboard" needs an address of its own that
// survives a refresh and a Back press. Every other view is open by definition —
// naming a company IS asking to see it.

import {
  isDocumentsSubPage,
  type DocumentsSubPage,
  type PanelMode,
} from "@/lib/panelMode";

// The two dashboard addresses. Panel state picks between them; both parse back
// to the dashboard mode.
export const DASHBOARD_PATH = "/";
export const DASHBOARD_OPEN_PATH = "/dashboard";

// The company slot for a role with no parent Company yet, mirroring the
// breadcrumb's `<unaffiliated>` placeholder.
export const UNAFFILIATED = "unaffiliated";

// What a path SAYS, before anything is looked up: slugs, not ids. `entity` is
// deliberately un-disambiguated — a bare depth-1 segment could name either a
// company or a lead, and only the database can say which.
export type PanelPath =
  // `open` distinguishes /dashboard from / — same mode, panel shown vs stowed.
  | { kind: "dashboard"; open: boolean }
  | { kind: "documents"; subPage: DocumentsSubPage }
  | { kind: "analytics" }
  | { kind: "entity"; entity: string }
  | { kind: "shortlist"; company: string }
  | { kind: "job"; company: string; job: string }
  | { kind: "application"; company: string; job: string };

// Total: any path that isn't grammatical is the dashboard, so a hand-typed or
// stale URL degrades instead of erroring.
export function parsePanelUrl(pathname: string): PanelPath {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // Anything outside the grammar degrades to the dashboard, open iff the path
  // was reaching for one — a mistyped /dashboard/xyz still wanted the panel.
  const under = segments[0] === "dashboard";
  const dashboard = { kind: "dashboard", open: under } as const;
  if (!under) return dashboard;

  const [, first, second, third] = segments;
  if (first === undefined) return dashboard;
  if (segments.length > 4) return dashboard;

  if (first === "documents") {
    if (second === undefined) return { kind: "documents", subPage: "index" };
    if (third !== undefined || !isDocumentsSubPage(second)) {
      return dashboard;
    }
    return { kind: "documents", subPage: second };
  }
  if (first === "analytics") {
    return second === undefined ? { kind: "analytics" } : dashboard;
  }

  if (second === undefined) return { kind: "entity", entity: first };
  if (second === "shortlist") {
    return third === undefined
      ? { kind: "shortlist", company: first }
      : dashboard;
  }
  if (third === undefined) return { kind: "job", company: first, job: second };
  if (third === "application") {
    return { kind: "application", company: first, job: second };
  }
  return dashboard;
}

// The panel state the writer reads. Declared structurally so this module
// imports nothing from src/server/ — the real view payloads satisfy it.
export type PanelUrlState = {
  panelMode: PanelMode;
  viewedCompany: { slug: string } | null;
  viewedJob: {
    id: string;
    slug: string | null;
    company: { slug: string } | null;
  } | null;
  viewedOpportunity: { id: string; slug: string | null } | null;
  viewedBoard: { companySlug: string | null } | null;
  viewedApplication: {
    jobId: string;
    jobSlug: string | null;
    company: { slug: string } | null;
  } | null;
  documentsNav: { subPage: DocumentsSubPage };
  // Only the dashboard has two addresses; every other mode is open by
  // definition, so this is read for that case alone.
  rightCollapsed: boolean;
};

// `null` means "this state has no address" — an entity mode whose payload
// hasn't arrived yet. The panel renders its empty hint in that gap, and the
// writer leaves the URL alone rather than flickering it to the dashboard.
// (The SSE pair sets the payloads and the mode in two separate updates, so the
// in-between state is reached on every agent-driven panel move.)
export function panelUrl(panel: PanelUrlState): string | null {
  switch (panel.panelMode) {
    case "dashboard":
      return panel.rightCollapsed ? DASHBOARD_PATH : DASHBOARD_OPEN_PATH;
    case "documents": {
      const { subPage } = panel.documentsNav;
      return subPage === "index"
        ? path("documents")
        : path("documents", subPage);
    }
    case "analytics":
      return path("analytics");
    case "company-context":
      return panel.viewedCompany && path(panel.viewedCompany.slug);
    case "shortlist-board":
      return panel.viewedBoard?.companySlug
        ? path(panel.viewedBoard.companySlug, "shortlist")
        : null;
    case "opportunity-detail":
      return (
        panel.viewedOpportunity &&
        path(panel.viewedOpportunity.slug ?? panel.viewedOpportunity.id)
      );
    case "job-detail":
      return (
        panel.viewedJob &&
        path(
          panel.viewedJob.company?.slug ?? UNAFFILIATED,
          panel.viewedJob.slug ?? panel.viewedJob.id,
        )
      );
    case "application":
      return (
        panel.viewedApplication &&
        path(
          panel.viewedApplication.company?.slug ?? UNAFFILIATED,
          panel.viewedApplication.jobSlug ?? panel.viewedApplication.jobId,
          "application",
        )
      );
  }
}

function path(...segments: string[]): string {
  return `/dashboard/${segments.map(encodeURIComponent).join("/")}`;
}
