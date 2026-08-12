// All widget-submission parsers, consolidated. A widget submission is a user
// chat message carrying the hidden <!--widget-response:{...}--> marker; each
// parser turns that marker into a typed, validated submission (or null). These
// are PURE — no DB, no side-effects — which is what lets the pipeline runners
// import their parser without dragging prisma or risking an import cycle.
//
// The top-level submissions (next_company_picker, company_disambiguation,
// add_more_companies) are dispatched by dispatchTopLevelSubmission; the
// per-widget dispatch bodies live in the sibling dispatch*.ts files. The
// walkthrough submissions are dispatched inside the walkthrough state machine —
// only their parser lives here.
//
// Marker extraction + JSON.parse is shared via extractWidgetMarker; each parser
// only owns its per-kind field validation.

import { extractWidgetMarker } from "@/lib/widgetMarker";

// ---------------------------------------------------------------------------
// Top-level: settling a negotiation panel. Emitted by the panel's own
// "looks good to me" pill when nothing is left to argue about; dispatched by
// dispatchCommitNegotiation, which re-derives that claim before acting on it.
// ---------------------------------------------------------------------------

export type CommitNegotiationSubmission =
  { panel: "discovery" } | { panel: "shortlist-board"; companyId: string };

export function parseCommitNegotiationSubmission(
  userMessage: string,
): CommitNegotiationSubmission | null {
  const obj = extractWidgetMarker(userMessage);
  if (!obj || obj.kind !== "commit_negotiation") return null;
  if (obj.panel === "discovery") return { panel: "discovery" };
  if (obj.panel === "shortlist-board" && typeof obj.companyId === "string") {
    return { panel: "shortlist-board", companyId: obj.companyId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Walkthrough pipeline widgets: confirm_revive_company,
// confirm_application_submit, next_job_picker. Dispatched by the walkthrough
// state machine (handleWidgetSubmission).
// ---------------------------------------------------------------------------

type WalkthroughWidgetSubmission =
  | { kind: "confirm_revive_company"; companyId: string; answer: "yes" | "no" }
  | { kind: "confirm_application_submit"; jobId: string }
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

export function parseWidgetSubmission(
  userMessage: string,
): WalkthroughWidgetSubmission | null {
  const obj = extractWidgetMarker(userMessage);
  if (!obj) return null;
  if (
    obj.kind === "confirm_revive_company" &&
    typeof obj.companyId === "string" &&
    (obj.answer === "yes" || obj.answer === "no")
  ) {
    return {
      kind: "confirm_revive_company",
      companyId: obj.companyId,
      answer: obj.answer,
    };
  }
  if (
    obj.kind === "confirm_application_submit" &&
    typeof obj.jobId === "string"
  ) {
    return { kind: "confirm_application_submit", jobId: obj.jobId };
  }
  if (obj.kind === "next_job_picker" && typeof obj.companyId === "string") {
    if (obj.choice === "pick" && typeof obj.jobId === "string") {
      return {
        kind: "next_job_picker",
        companyId: obj.companyId,
        choice: "pick",
        jobId: obj.jobId,
      };
    }
    if (obj.choice === "caught_up") {
      return {
        kind: "next_job_picker",
        companyId: obj.companyId,
        choice: "caught_up",
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Grow-the-watchlist widgets: company_disambiguation (resolve a name collision
// the URL hunter flagged) and add_more_companies (done, or keep hunting). Both
// are dispatched at the TOP LEVEL (dispatchTopLevelSubmission), before Hank runs
// at all, so either one commits the same way from ANY conversation — growing the
// watchlist is conversational, not a flow of its own. (Picking WHICH companies
// is not a widget at all: it's marks on the discovery panel, relayed as
// panel_edits and settled by Hank's commit_discovery.)
// ---------------------------------------------------------------------------

// A company on its way onto the watchlist. `context` (the search's own case for
// it) and `url` (the board URL the search captured) travel with the name so the
// URL hunter resolves the right company on a name collision. Both optional.
export type PickedCompany = { name: string; context?: string; url?: string };

// One resolved branch of a flagged name collision: the user picked
// which real company the ambiguous name maps to, identified by the verified
// board URL the hunter offered.
export type DisambiguationResolution = {
  companyId: string;
  chosenUrl: string;
  canonicalName: string;
  shortDescription: string;
};

// add_more_companies submission — the yes/no that follows a completed add.
// "yes" re-enters discovery; "no" hands off to what's next. Returns null when
// the message isn't an add_more_companies marker.
export function parseAddMoreCompaniesSubmission(
  userMessage: string,
): { answer: "yes" | "no"; settled: number } | null {
  const obj = extractWidgetMarker(userMessage);
  if (!obj || obj.kind !== "add_more_companies") return null;
  if (obj.answer !== "yes" && obj.answer !== "no") return null;
  // Absent on markers persisted before the count rode along — treat as "we
  // don't know", which errs toward wrapping rather than skipping it.
  const settled = typeof obj.settled === "number" ? obj.settled : 1;
  return { answer: obj.answer, settled };
}

// company_disambiguation submission — the user resolved one or more flagged name
// collisions. Returns null when the message isn't a disambiguation marker (or
// carried no valid resolutions).
export function parseCompanyDisambiguationSubmission(
  userMessage: string,
): { resolved: DisambiguationResolution[] } | null {
  const obj = extractWidgetMarker(userMessage);
  if (!obj || obj.kind !== "company_disambiguation") return null;
  const resolved = asResolutions(obj.resolved);
  if (resolved.length === 0) return null;
  return { resolved };
}

function asResolutions(v: unknown): DisambiguationResolution[] {
  if (!Array.isArray(v)) return [];
  const out: DisambiguationResolution[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (
      typeof o.companyId === "string" &&
      o.companyId.trim() &&
      typeof o.chosenUrl === "string" &&
      o.chosenUrl.trim() &&
      typeof o.canonicalName === "string" &&
      o.canonicalName.trim() &&
      typeof o.shortDescription === "string"
    ) {
      out.push({
        companyId: o.companyId.trim(),
        chosenUrl: o.chosenUrl.trim(),
        canonicalName: o.canonicalName.trim(),
        shortDescription: o.shortDescription.trim(),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// next_company_picker widget: the between-pipeline "what's next" picker.
// Dispatched at chat-entry level (dispatchNextCompanyPicker).
// ---------------------------------------------------------------------------

export type NextCompanyPickerSubmission =
  | { kind: "next_company_picker"; choice: "company"; companyId: string }
  | {
      kind: "next_company_picker";
      choice: "opportunity";
      opportunityId: string;
    }
  // A specific job surfaced as immediate on its own (interview debrief / offer
  // / a due job-level deferral). Picking it opens the job and drops into the
  // free-form default flow so Hank can run that conversation directly.
  | { kind: "next_company_picker"; choice: "job"; jobId: string }
  | { kind: "next_company_picker"; choice: "add_companies" };

export function parseNextCompanyPickerSubmission(
  userMessage: string,
): NextCompanyPickerSubmission | null {
  const obj = extractWidgetMarker(userMessage);
  if (!obj) return null;
  if (obj.kind !== "next_company_picker") return null;
  if (obj.choice === "company" && typeof obj.companyId === "string") {
    return {
      kind: "next_company_picker",
      choice: "company",
      companyId: obj.companyId,
    };
  }
  if (obj.choice === "opportunity" && typeof obj.opportunityId === "string") {
    return {
      kind: "next_company_picker",
      choice: "opportunity",
      opportunityId: obj.opportunityId,
    };
  }
  if (obj.choice === "job" && typeof obj.jobId === "string") {
    return {
      kind: "next_company_picker",
      choice: "job",
      jobId: obj.jobId,
    };
  }
  if (obj.choice === "add_companies") {
    return { kind: "next_company_picker", choice: "add_companies" };
  }
  return null;
}
