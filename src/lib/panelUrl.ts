// The right panel's address: the URL a panel state writes, and the panel state
// a URL names. Pure and I/O-free on purpose — the RSC shell parses the incoming
// path with the same code the client writes back, so the two can't drift.
//
// The grammar mirrors the breadcrumb the panel already renders, lowercased,
// with entity slugs for the names:
//
//   /                                        dashboard
//   /dashboard/documents[/<sub-page>]        documents
//   /dashboard/analytics                     analytics
//   /dashboard/<company>                     company page
//   /dashboard/<company>/shortlist           shortlist board
//   /dashboard/<company>/<job>               job page
//   /dashboard/<company>/<job>/application   application page
//   /dashboard/<lead>                        opportunity page
//
// `/dashboard` alone is an accepted alias for `/` — the client canonicalizes it
// on the seed.

import {
  isDocumentsSubPage,
  type DocumentsSubPage,
  type PanelMode,
} from "@/lib/panelMode";

export const DASHBOARD_PATH = "/";

// The company slot for a role with no parent Company yet, mirroring the
// breadcrumb's `<unaffiliated>` placeholder.
export const UNAFFILIATED = "unaffiliated";

// What a path SAYS, before anything is looked up: slugs, not ids. `entity` is
// deliberately un-disambiguated — a bare depth-1 segment could name either a
// company or a lead, and only the database can say which.
export type PanelPath =
  | { kind: "dashboard" }
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
  if (segments[0] !== "dashboard") return { kind: "dashboard" };

  const [, first, second, third] = segments;
  if (first === undefined) return { kind: "dashboard" };
  if (segments.length > 4) return { kind: "dashboard" };

  if (first === "documents") {
    if (second === undefined) return { kind: "documents", subPage: "index" };
    if (third !== undefined || !isDocumentsSubPage(second)) {
      return { kind: "dashboard" };
    }
    return { kind: "documents", subPage: second };
  }
  if (first === "analytics") {
    return second === undefined ? { kind: "analytics" } : { kind: "dashboard" };
  }

  if (second === undefined) return { kind: "entity", entity: first };
  if (second === "shortlist") {
    return third === undefined
      ? { kind: "shortlist", company: first }
      : { kind: "dashboard" };
  }
  if (third === undefined) return { kind: "job", company: first, job: second };
  if (third === "application") {
    return { kind: "application", company: first, job: second };
  }
  return { kind: "dashboard" };
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
};

// `null` means "this state has no address" — an entity mode whose payload
// hasn't arrived yet. The panel renders its empty hint in that gap, and the
// writer leaves the URL alone rather than flickering it to the dashboard.
// (The SSE pair sets the payloads and the mode in two separate updates, so the
// in-between state is reached on every agent-driven panel move.)
export function panelUrl(panel: PanelUrlState): string | null {
  switch (panel.panelMode) {
    case "dashboard":
      return DASHBOARD_PATH;
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
