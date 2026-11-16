// The isomorphic widget registry — the single source of truth for everything
// about a widget EXCEPT its React rendering (that's registry/components.tsx,
// which is client-only and can't be imported by the server / node harness).
//
// `satisfies Record<WidgetKind, WidgetDef<any>>` is the load-bearing line: add
// a kind to the WidgetKind union and this file fails to compile until the kind
// is registered here. That's what makes it impossible to ship a widget whose
// text projection / persona binding was silently forgotten.
//
// Consumers:
//   - renderWidgetText (below) — server loadSessionMessages grounding + the QA
//     persona's perceived text.
//   - buildRenderedWidget (scripts/.../widgetRender.ts) — derives the persona
//     harness view from each def's `harness`.
//   - PipelineWidgetSlot (../index.tsx) — pairs these defs (validate) with the
//     client component map.

import type { WidgetKind } from "@/shared/widgetKinds";

import { addMoreCompaniesDef } from "./addMoreCompanies/def";
import { companyDisambiguationDef } from "./companyDisambiguation/def";
import { confirmApplicationSubmitDef } from "./confirmApplicationSubmit/def";
import { confirmReviveCompanyDef } from "./confirmReviveCompany/def";
import { nextCompanyPickerDef } from "./nextCompanyPicker/def";
import { nextJobPickerDef } from "./nextJobPicker/def";

import type { ErasedWidgetDef } from "./defineWidget";

const WIDGET_DEFS = {
  add_more_companies: addMoreCompaniesDef,
  company_disambiguation: companyDisambiguationDef,
  confirm_revive_company: confirmReviveCompanyDef,
  confirm_application_submit: confirmApplicationSubmitDef,
  next_company_picker: nextCompanyPickerDef,
  next_job_picker: nextJobPickerDef,
} satisfies Record<WidgetKind, ErasedWidgetDef>;

// Runtime-safe accessor (kind arrives as a plain string from persisted history
// / SSE, not a typed WidgetKind). Returns the payload-erased def so callers can
// invoke toText/validate/harness against an `unknown` payload.
export function getWidgetDef(kind: string): ErasedWidgetDef | undefined {
  return (WIDGET_DEFS as Record<string, ErasedWidgetDef>)[kind];
}

// A kind no longer in the registry — only old persisted history carries one.
// Nothing emits an unregistered kind (emitters take the WidgetKind union), so
// unknown here means retired, not malformed.
export function isRetiredWidgetKind(kind: string): boolean {
  return getWidgetDef(kind) === undefined;
}

// Render `kind` + `payload` to the plain TEXT the user saw — the visible
// labels / options / reasoning, never raw JSON, ids, or the kind enum. Returns
// null for a retired kind, a kind with no text projection, or a malformed
// payload. Never throws — a bad historical payload must
// not break the whole chat replay (loadSessionMessages runs on every turn).
//
// This is the single source of truth for "what did the widget show the human",
// consumed by two callers that must stay in lockstep:
//   1. loadSessionMessages (src/server/agent/runtime/session.ts) — converts
//      persisted `pipeline_widget` blocks into model-visible assistant text so
//      Hank remembers what it showed when the user types free text about it.
//   2. The QA persona harness (scripts/regression/conversations/) — the
//      simulated user perceives exactly this text, keeping the model's
//      grounding == the simulated user's perception.
export function renderWidgetText(
  kind: string,
  payload: unknown,
): string | null {
  try {
    const def = getWidgetDef(kind);
    return def?.toText ? def.toText(payload) : null;
  } catch {
    return null;
  }
}
