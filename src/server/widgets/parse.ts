// All widget-submission parsers, consolidated. A widget submission is a user
// chat message carrying the hidden <!--widget-response:{...}--> marker; each
// parser turns that marker into a typed, validated submission (or null). These
// are PURE — no DB, no side-effects — which is what lets the pipeline runners
// import their parser without dragging prisma or risking an import cycle.
//
// The top-level submissions (next_company_picker, company_checklist,
// company_disambiguation) are dispatched by dispatchTopLevelSubmission; the
// per-widget dispatch bodies live in the sibling dispatch*.ts files. The
// walkthrough submissions are dispatched inside the walkthrough state machine —
// only their parser lives here.
//
// Marker extraction + JSON.parse is shared via extractWidgetMarker; each parser
// only owns its per-kind field validation.

import { extractWidgetMarker } from "@/lib/widgetMarker";

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
// Grow-the-watchlist widgets: company_checklist (pick from the find_companies
// suggestion set) and company_disambiguation (resolve a name collision the URL
// hunter flagged). Both are dispatched at the TOP LEVEL
// (dispatchTopLevelSubmission), before Hank runs at all, so a checklist emitted
// by the find_companies tool from ANY conversation commits its picks the same
// way — growing the watchlist is conversational, not a flow of its own.
// ---------------------------------------------------------------------------

// A company kept from the checklist. `context` (the suggestion reasoning) and
// `url` (the captured board URL) ride back so the URL hunter resolves the right
// company on a name collision. Both optional.
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

// company_checklist submission — the user's picks from a find_companies
// checklist. `picked` can be empty (they unchecked everything / "none of
// these"); the dispatcher handles the empty batch. Returns null when the
// message isn't a company_checklist marker.
export function parseCompanyChecklistSubmission(
  userMessage: string,
): { picked: PickedCompany[] } | null {
  const obj = extractWidgetMarker(userMessage);
  if (!obj || obj.kind !== "company_checklist") return null;
  return { picked: asPickedCompanies(obj.picked) };
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

// Parse the `picked` array. Current shape is objects {name, context?, url?};
// legacy markers (already in chat history) carried a bare string[] — accept
// both so an old persisted marker still round-trips to a name list.
function asPickedCompanies(v: unknown): PickedCompany[] {
  if (!Array.isArray(v)) return [];
  const out: PickedCompany[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ name: item.trim() });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (typeof o.name === "string" && o.name.trim()) {
        out.push({
          name: o.name.trim(),
          context:
            typeof o.context === "string" && o.context.trim()
              ? o.context.trim()
              : undefined,
          url:
            typeof o.url === "string" && o.url.trim()
              ? o.url.trim()
              : undefined,
        });
      }
    }
  }
  return out;
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
