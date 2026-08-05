// Single source of truth for the widget-response marker protocol. Widgets
// submit chat messages carrying a hidden HTML-comment marker:
//
//   <!--widget-response:{"kind":"<widget_kind>", ...payload}-->\n[visible label]
//
// The client's buildWidgetSubmissionMessage writes it; the server parsers in
// src/server/widgets/parse.ts + the walkthrough state machine read it. The regex
// and the prefix/suffix have exactly one copy, here. Lives in src/lib
// (alongside widgetKinds.ts) so both client and server import the same one.

const WIDGET_MARKER_RE = /<!--widget-response:(\{[\s\S]*?\})-->/;

// Extract + JSON.parse the marker payload in one shot. Returns the raw parsed
// object (loosely typed — callers do their own per-kind field validation) or
// null on: empty input, no marker, or malformed JSON.
export function extractWidgetMarker(
  message: string | null | undefined,
): Record<string, unknown> | null {
  if (!message) return null;
  const m = WIDGET_MARKER_RE.exec(message);
  if (!m) return null;
  try {
    const obj: unknown = JSON.parse(m[1]);
    return obj && typeof obj === "object"
      ? (obj as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
