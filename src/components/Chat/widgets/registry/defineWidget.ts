// The per-widget "definition" contract. Every widget kind owns ONE def object
// (in registry/<kind>/def.ts) bundling everything keyed by kind, so a new widget
// is one file and not three parallel switch statements to keep in sync:
//
//   - toText     — project the payload to the plain TEXT the user saw (model
//                  grounding in loadSessionMessages + the QA persona's
//                  perception).
//   - validate   — runtime payload guard for widgets whose payload can arrive
//                  malformed from chat history. Was in the widget .tsx.
//   - harness    — how the QA persona acts on the widget (actionHint / multi-
//                  select / translate a choice back into a submission marker).
//                  Was widgetRender.ts's per-kind builders.
//
// The def is ISOMORPHIC on purpose — no React, no styled-components — so the
// server (session.ts) and the node QA harness can import the whole registry.
// The React component lives beside the def in the same folder (Widget.tsx) but
// is assembled into a SEPARATE client-only map (registry/components.tsx); the
// "use client" boundary is the one reason the def and the component can't be a
// single object. Both maps are `Record<WidgetKind, …>` so adding a kind to the
// union is a COMPILE error until it's registered — that's the whole point.

import type { WidgetKind } from "@/lib/widgetKinds";

import { buildWidgetSubmissionMessage, type WidgetSubmission } from "../types";

// A persona's choice against a rendered widget. Widgets with a single option
// use `optionRef`; multi-select widgets use `selection`; the shortlist's
// optional reason rides in `note`.
export type WidgetAction = {
  optionRef?: string | number;
  selection?: (string | number)[];
  note?: string;
};

export type TranslateResult = { marker: string } | { error: string };

// The QA-persona harness bindings for one widget. Absent from a def ⇒ the
// persona can't drive that widget and buildRenderedWidget returns null — true
// of the two shortlist gates, which never reach the persona in a normal flow.
type WidgetHarness<P> = {
  actionHint: string;
  multiSelect: boolean;
  translate: (payload: P, action: WidgetAction) => TranslateResult;
};

// The type each def.ts author writes against — strongly typed to its payload P,
// so toText/validate/harness get full checking inside the def file.
export type WidgetDef<P = unknown> = {
  kind: WidgetKind;
  // null ⇒ this widget has no text projection (gates that never persist into
  // replay). An explicit null is a visible opt-out, not a silently-missing
  // switch case.
  toText: ((payload: P) => string) | null;
  validate?: (payload: unknown) => P | null;
  harness?: WidgetHarness<P>;
};

// The type the registry STORES and consumers read — payload erased to `unknown`.
// Every consumer (renderWidgetText, the persona harness, PipelineWidgetSlot)
// only ever holds an `unknown` payload from persisted history / SSE, so erasing
// P at the registry boundary is exactly right — and it lets the map be a plain
// `Record<WidgetKind, WidgetDef>` with no `any` and full exhaustiveness.
export type ErasedWidgetDef = WidgetDef<unknown>;

// Identity helper: infers P from the literal so each def.ts is fully type-
// checked against its payload without restating the generic, then erases P to
// `unknown` at the registry boundary. The single `as unknown as` here is the
// type-erasure seam — it's why no call site needs an `any`.
export function defineWidget<P>(def: WidgetDef<P>): ErasedWidgetDef {
  return def as unknown as ErasedWidgetDef;
}

// Shared helpers for translate() bodies — same marker construction the real
// client uses, so marker/parser parity stays structural, not copy-pasted.
export function widgetMarker(
  submission: WidgetSubmission,
  visibleLabel: string,
): TranslateResult {
  return { marker: buildWidgetSubmissionMessage(submission, visibleLabel) };
}

export function normRef(ref: string | number | undefined): string {
  return String(ref ?? "")
    .trim()
    .toLowerCase();
}
