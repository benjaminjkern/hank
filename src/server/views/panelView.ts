// The whole right panel, loaded from a URL. Feeds the shell's first paint and
// the popstate refetch, so a reload and a Back press land on identical state.
// The payload type is shared/views/panelView.ts.
//
// Sibling of showEvents.ts rather than an arm on it: buildShowEvents derives its
// mode from WHICH ENTITY loaded, which can't express the board or the
// application (hence its own sibling builders). A URL names the mode outright,
// so this dispatches on the route and reuses the same leaf loaders.

import {
  resolveCompanyBySlug,
  resolveJobBySlug,
  resolveOpportunityBySlug,
} from "@/server/entities/resolveBySlug";
import type { PanelPath } from "@/shared/panelUrl";
import type { PanelView } from "@/shared/views/panelView";

import { loadApplicationView } from "./application";
import { loadDiscoveryList } from "./discoveryList";
import { getFocusedCompanyView } from "./getFocusedCompany";
import { getFocusedJobView } from "./getFocusedJob";
import { getFocusedOpportunityView } from "./getFocusedOpportunity";
import { loadShortlistBoard } from "./shortlistBoard";

const EMPTY = {
  company: null,
  job: null,
  opportunity: null,
  board: null,
  application: null,
  discovery: null,
  documentsSubPage: "index",
} as const;

// The dashboard with the panel stowed — also where an unresolvable address
// degrades to, since a slug that's gone shouldn't fling a panel open.
export const DASHBOARD_PANEL_VIEW: PanelView = {
  panelMode: "dashboard",
  ...EMPTY,
  panelOpen: false,
};

// Anything that doesn't resolve — a slug that's gone, a role the user doesn't
// track, someone else's lead — degrades to the dashboard rather than 404ing,
// and the client rewrites the URL to match.
export async function loadPanelView(
  userId: string,
  path: PanelPath,
): Promise<PanelView> {
  switch (path.kind) {
    case "dashboard":
      return { ...DASHBOARD_PANEL_VIEW, panelOpen: path.open };

    case "documents":
      return {
        panelMode: "documents",
        ...EMPTY,
        panelOpen: true,
        documentsSubPage: path.subPage,
      };

    case "analytics":
      return { panelMode: "analytics", ...EMPTY, panelOpen: true };

    // Agent-opened in practice, but addressable so a refresh mid-marking lands
    // back on the list rather than the dashboard.
    case "discovery": {
      const discovery = await loadDiscoveryList(userId);
      return { panelMode: "discovery", ...EMPTY, panelOpen: true, discovery };
    }

    // A bare segment is a company or a lead; companies win, so a slug that
    // collides across the two makes the lead unreachable by URL.
    case "entity": {
      const company = await loadCompany(userId, path.entity);
      if (company)
        return {
          panelMode: "company-context",
          ...EMPTY,
          panelOpen: true,
          company,
        };
      const opportunity = await loadOpportunity(userId, path.entity);
      return opportunity
        ? {
            panelMode: "opportunity-detail",
            ...EMPTY,
            panelOpen: true,
            opportunity,
          }
        : DASHBOARD_PANEL_VIEW;
    }

    case "shortlist": {
      const resolved = await resolveCompanyBySlug(userId, path.company);
      if (!resolved.ok) return DASHBOARD_PANEL_VIEW;
      const board = await loadShortlistBoard(userId, resolved.value.id);
      return board
        ? { panelMode: "shortlist-board", ...EMPTY, panelOpen: true, board }
        : DASHBOARD_PANEL_VIEW;
    }

    // The company segment is decorative — Job.slug is globally unique, so the
    // role resolves on its own and the client canonicalizes a stale one away.
    case "job": {
      const resolved = await resolveJobBySlug(userId, path.job);
      if (!resolved.ok) return DASHBOARD_PANEL_VIEW;
      const job = await getFocusedJobView(userId, resolved.value.id);
      return job
        ? { panelMode: "job-detail", ...EMPTY, panelOpen: true, job }
        : DASHBOARD_PANEL_VIEW;
    }

    case "application": {
      const resolved = await resolveJobBySlug(userId, path.job);
      if (!resolved.ok) return DASHBOARD_PANEL_VIEW;
      const application = await loadApplicationView(userId, resolved.value.id);
      return application
        ? { panelMode: "application", ...EMPTY, panelOpen: true, application }
        : DASHBOARD_PANEL_VIEW;
    }
  }
}

async function loadCompany(userId: string, slug: string) {
  const resolved = await resolveCompanyBySlug(userId, slug);
  if (!resolved.ok) return null;
  return await getFocusedCompanyView(userId, resolved.value.id);
}

async function loadOpportunity(userId: string, slug: string) {
  const resolved = await resolveOpportunityBySlug(userId, slug);
  if (!resolved.ok) return null;
  return await getFocusedOpportunityView(userId, resolved.value.id);
}
