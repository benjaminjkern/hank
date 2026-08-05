"use client";

// Pipeline widget dispatcher. Two sources:
//   1. The latest WidgetSegment in message history (persistent — emitted by
//      the pipeline state machine / runUserMessage as `pipeline_widget`
//      blocks on assistant ChatMessages; survives refresh).
//   2. `chatStore.currentWidget` (transient — set by applyEvent when a
//      `widget` SSE event arrives, cleared on next user send). Used by the
//      `next_company_picker` flow: handleWhatsNext yields `{type: "widget"}`
//      so the picker appears live before the persistence row is fetched.
//
// History wins when both are present so a freshly-persisted widget beats a
// stale transient one. All widgets including shortlist_proposal flow
// through here — the typing-dismisses-widget rule (break on user message
// below) applies uniformly.
//
// Dispatch, the known-kind set, and payload validation all DERIVE from the
// widget registry (./registry). Adding a widget is a folder under registry/;
// there is no kind-keyed switch here to forget to update.

import { createElement, useEffect } from "react";

import { useChatStore } from "@/lib/chatStore";
import { reportClientEvent } from "@/lib/clientEvents";

import { getWidgetDef } from "./registry";
import { WIDGET_COMPONENTS } from "./registry/components";

import type { ComponentType } from "react";

type WidgetComponent = ComponentType<{
  payload: unknown;
  toolUseId?: string;
}>;

// The registry's component map viewed with uniform props — each real component
// keeps its own stricter Props; we only need a common shape to look one up and
// render it dynamically below.
const COMPONENTS = WIDGET_COMPONENTS as unknown as Record<
  string,
  WidgetComponent
>;

// Resolve a kind string to its component, or null if the dispatcher doesn't
// know it — the signal that drives the widget_failure report below.
function resolveComponent(kind: string): WidgetComponent | null {
  return COMPONENTS[kind] ?? null;
}

export function PipelineWidgetSlot() {
  const messages = useChatStore((s) => s.messages);
  const transient = useChatStore((s) => s.currentWidget);

  // Find newest WidgetSegment in message history. Stops at any USER message
  // — once the user has responded to a widget (by typing OR by submitting
  // a marker), it's consumed and shouldn't keep rendering above the
  // composer. This is the typing-dismisses-widget rule.
  let persistent: { kind: string; payload: unknown; toolUseId: string } | null =
    null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    if (m.role !== "assistant") continue;
    for (let j = m.segments.length - 1; j >= 0; j--) {
      const seg = m.segments[j];
      if (seg.kind !== "widget") continue;
      persistent = {
        kind: seg.widgetKind,
        payload: seg.payload,
        toolUseId: seg.toolUseId,
      };
      break;
    }
    if (persistent) break;
  }

  const widget =
    persistent ?? (transient ? { ...transient, toolUseId: "" } : null);

  // Detect a widget we can't render (unknown kind, or a payload that fails its
  // def's validate — only shortlist_proposal has one today). Cheap enough to
  // compute each render; the effect below keys off the resulting string so the
  // report fires once per distinct failure (not during render — keeping the
  // render pure).
  let widgetFailureKind: string | null = null;
  if (widget) {
    const def = getWidgetDef(widget.kind);
    if (!resolveComponent(widget.kind)) widgetFailureKind = widget.kind;
    else if (def?.validate && !def.validate(widget.payload))
      widgetFailureKind = widget.kind;
  }
  useEffect(() => {
    if (!widgetFailureKind) return;
    reportClientEvent({
      source: "widget_failure",
      severity: "error",
      summary:
        "A chat widget couldn't be shown to the user because its data was malformed.",
      context: { widgetKind: widgetFailureKind },
    });
  }, [widgetFailureKind]);

  if (!widget) return null;
  const component = resolveComponent(widget.kind);
  if (!component) return null;

  // Run the def's validate (if any) so a malformed payload renders nothing
  // instead of throwing — the shortlist widget relies on this. Widgets without
  // a validate pass the payload through untouched.
  const def = getWidgetDef(widget.kind);
  const payload = def?.validate ? def.validate(widget.payload) : widget.payload;
  if (def?.validate && !payload) return null;

  // createElement (not <Component/>) because the element type is resolved from
  // the registry at runtime — a dynamic component reference, not a component
  // authored in this render.
  return createElement(component, { payload, toolUseId: widget.toolUseId });
}
