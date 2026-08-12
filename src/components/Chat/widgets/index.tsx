"use client";

// Pipeline widget dispatcher. One source: the latest WidgetSegment in message
// history. A widget streams as a `pipeline_widget` event that recordTranscript
// writes to its assistant row as it goes, and applyEvent appends the matching
// segment — so the same lookup serves the live turn and a refresh, with no
// separate transient channel to diverge from it.
//
// All widgets flow through here, so the typing-dismisses-widget rule (break on
// user message below) applies uniformly.
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

  // Find newest WidgetSegment in message history. Stops at any USER message
  // — once the user has responded to a widget (by typing OR by submitting
  // a marker), it's consumed and shouldn't keep rendering above the
  // composer. This is the typing-dismisses-widget rule.
  let widget: { kind: string; payload: unknown; toolUseId: string } | null =
    null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    if (m.role !== "assistant") continue;
    for (let j = m.segments.length - 1; j >= 0; j--) {
      const seg = m.segments[j];
      if (seg.kind !== "widget") continue;
      widget = {
        kind: seg.widgetKind,
        payload: seg.payload,
        toolUseId: seg.toolUseId,
      };
      break;
    }
    if (widget) break;
  }

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
