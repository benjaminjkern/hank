// Render a live Hank widget to the plain TEXT a real user would see, plus
// translate the persona's chosen option back into the exact
// <!--widget-response:{...}--> marker the server widget handlers accept.
//
// Both halves now live in the widget registry (src/components/Chat/widgets/
// registry/<kind>/def.ts): `def.toText` is the perceived text and `def.harness`
// is the actionHint + multiSelect + translate. Co-locating them there (with the
// widget's payload type and component) is what keeps the option ORDERING used
// in the text and in translate() from drifting — they read the same payload in
// the same file. This module is now just the harness-shaped adapter over those
// defs; adding a widget needs no edit here.

import { getWidgetDef } from "@/components/Chat/widgets/registry";
import type {
  WidgetAction,
  TranslateResult,
} from "@/components/Chat/widgets/registry/defineWidget";
import type { WidgetKind } from "@/lib/widgetKinds";

export type PersonaWidgetAction = WidgetAction;
export type { TranslateResult };

export type RenderedWidget = {
  kind: WidgetKind;
  // The persona-facing render of the widget (what shows above the composer).
  text: string;
  // One-line instruction on how to respond to THIS widget shape.
  actionHint: string;
  multiSelect: boolean;
  // Build the submission marker from the persona's choice.
  translate: (action: PersonaWidgetAction) => TranslateResult;
};

// Build the RenderedWidget for a live widget event. Returns null for a kind the
// registry can't drive as a persona widget — an unknown kind, or one with no
// text projection / no harness binding (the two shortlist gates), which the
// caller treats as a render failure → halt-worthy.
export function buildRenderedWidget(
  kind: WidgetKind,
  payload: unknown,
): RenderedWidget | null {
  const def = getWidgetDef(kind);
  if (!def?.toText || !def.harness) return null;
  const { toText, harness } = def;
  return {
    kind,
    text: toText(payload),
    actionHint: harness.actionHint,
    multiSelect: harness.multiSelect,
    translate: (action) => harness.translate(payload, action),
  };
}
