// Which view goes on screen. Loads a detail view and emits the `show` /
// `panel_mode` events that move the right panel to it — the one dispatcher every
// show_* tool and deterministic mutator goes through.

import type { EntryTarget, UiEvent } from "@/server/agent/contracts";
import { getFocusedCompanyView } from "@/server/views/getFocusedCompany";
import { getFocusedJobView } from "@/server/views/getFocusedJob";
import { getFocusedOpportunityView } from "@/server/views/getFocusedOpportunity";

import { loadApplicationView, type ApplicationView } from "./application";
import { loadShortlistBoard, type ShortlistBoardView } from "./shortlistBoard";

// Which entity to put on screen. An empty target ({}) is the dashboard.
export type ShowTarget = {
  companyId?: string | null;
  jobId?: string | null;
  opportunityId?: string | null;
};

// Emit the panel-switch events for an EXPLICIT entity (no session-slot read, no
// session write) so a show_* tool / deterministic mutator
// can put that entity's detail page on the user's screen without touching focus.
// Emits a `show` event (updates only the client's viewed*/panelMode, never the
// sticky focus pill) + a `panel_mode`, using the same job > opportunity >
// company precedence. Loads only the requested entity; the others stay null.
export async function buildShowEvents(
  userId: string,
  // Omit to fall back to the dashboard (after a wrap, a what's-next render, or
  // a stale-entity fallback).
  target: ShowTarget = {},
): Promise<{
  events: UiEvent[];
  mode: string;
  company: Awaited<ReturnType<typeof getFocusedCompanyView>>;
  job: Awaited<ReturnType<typeof getFocusedJobView>>;
  opportunity: Awaited<ReturnType<typeof getFocusedOpportunityView>>;
}> {
  const [company, job, opportunity] = await Promise.all([
    target.companyId
      ? getFocusedCompanyView(userId, target.companyId)
      : Promise.resolve(null),
    target.jobId
      ? getFocusedJobView(userId, target.jobId)
      : Promise.resolve(null),
    target.opportunityId
      ? getFocusedOpportunityView(userId, target.opportunityId)
      : Promise.resolve(null),
  ]);

  const mode:
    "dashboard" | "company-context" | "job-detail" | "opportunity-detail" = job
    ? "job-detail"
    : opportunity
      ? "opportunity-detail"
      : company
        ? "company-context"
        : "dashboard";

  return {
    events: [
      {
        type: "show",
        company,
        job,
        opportunity,
        board: null,
        application: null,
      },
      { type: "panel_mode", mode },
    ],
    mode,
    company,
    job,
    opportunity,
  };
}

// Sibling builder for the shortlist board — a SEPARATE entry rather than a new
// arm in buildShowEvents, because that one derives its mode from WHICH entity
// loaded and a per-company board is indistinguishable from company-context
// under that rule. Returns no events when the company doesn't exist.
export async function buildShortlistBoardEvents(
  userId: string,
  companyId: string,
): Promise<{ events: UiEvent[]; board: ShortlistBoardView | null }> {
  const board = await loadShortlistBoard(userId, companyId);
  if (!board) return { events: [], board: null };
  return {
    events: [
      {
        type: "show",
        company: null,
        job: null,
        opportunity: null,
        board,
        application: null,
      },
      { type: "panel_mode", mode: "shortlist-board" },
    ],
    board,
  };
}

// Sibling builder for a job's application page, separate for the same reason
// the board's is: buildShowEvents picks its mode from WHICH entity loaded, and
// an application is indistinguishable from its job under that rule.
export async function buildApplicationEvents(
  userId: string,
  jobId: string,
): Promise<{ events: UiEvent[]; application: ApplicationView | null }> {
  const application = await loadApplicationView(userId, jobId);
  if (!application) return { events: [], application: null };
  return {
    events: [
      {
        type: "show",
        company: null,
        job: null,
        opportunity: null,
        board: null,
        application,
      },
      { type: "panel_mode", mode: "application" },
    ],
    application,
  };
}

// EntryTarget → ShowTarget. A discovery entry names no entity and neither does
// an absent one, so both open the dashboard.
export function showTargetFor(t: EntryTarget | undefined): ShowTarget {
  if (t?.kind === "company") return { companyId: t.id };
  if (t?.kind === "job") return { jobId: t.id };
  if (t?.kind === "opportunity") return { opportunityId: t.id };
  return {};
}
