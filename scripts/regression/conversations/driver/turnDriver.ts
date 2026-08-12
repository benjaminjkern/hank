// Drive ONE user-perceived turn through Hank IN-PROCESS via runUserMessage
// (the exact function /api/chat invokes), collecting the LoopEvent stream and
// reconstructing the VISIBLE surface a real user would see: assistant
// markdown, deterministic status lines, collapsed tool-chip names, the active
// widget (rendered to text), and a right-panel hint.
//
// Consume-until-terminal: runUserMessage yields {type:"done"} on every normal
// path; the two top-level guard errors (NO_ANTHROPIC_KEY / ALREADY_STREAMING)
// `return` WITHOUT a trailing done, so we also break on those codes. Breaking
// out of the for-await calls the generator's return() → its finally runs
// clearActiveRun, so the next turn never trips the ALREADY_STREAMING guard.

import type { WidgetKind } from "@/lib/widgetKinds";
import type { UiEvent } from "@/server/agent/contracts";
import { runUserMessage } from "@/server/agent/runtime/runUserMessage";

import { resolvePanelHint } from "./panelHint";
import { buildRenderedWidget, type RenderedWidget } from "./widgetRender";

export type VisibleTurn = {
  assistantText: string;
  statusLines: string[];
  toolChips: string[];
  widget: { kind: WidgetKind; rendered: RenderedWidget | null } | null;
  panelHint: string;
  error: { message: string; code?: string } | null;
  stopped: boolean;
  // Diagnostic: every event type seen, in order. Not shown to the persona.
  eventTrace: string[];
};

const TERMINAL_ERROR_CODES = new Set(["NO_ANTHROPIC_KEY", "ALREADY_STREAMING"]);

export async function driveTurn(args: {
  userId: string;
  sessionId: string;
  userMessage: string;
  signal: AbortSignal;
}): Promise<VisibleTurn> {
  const textParts: string[] = [];
  const statusLines: string[] = [];
  const toolChips: string[] = [];
  const seenTools = new Set<string>();
  const eventTrace: string[] = [];
  let widgetEvent: { kind: WidgetKind; payload: unknown } | null = null;
  // Last `show` UI event this turn — drives the panel hint (focus is ephemeral).
  let lastShow: Extract<UiEvent, { type: "show" }> | null = null;
  let error: { message: string; code?: string } | null = null;
  let stopped = false;

  const gen = runUserMessage({
    userId: args.userId,
    userMessage: args.userMessage,
    signal: args.signal,
    sessionIdOverride: args.sessionId,
  });

  // Mirror the /api/chat route's outer catch: a thrown pipeline error becomes a
  // visible error event (so the persona can see + halt on it), not a hard crash
  // of the harness. runUserMessage propagates pipeline exceptions rather than
  // yielding them, so we wrap the consumption.
  try {
    for await (const ev of gen) {
      eventTrace.push(ev.type);
      switch (ev.type) {
        case "text":
          // Sub-agent trace text carries parentToolUseId — the user never sees
          // it inline. Only top-level assistant text is visible.
          if (!ev.parentToolUseId) textParts.push(ev.text);
          break;
        case "tool_use_start":
          // Collapsed chip: top-level tools only, distinct names.
          if (!ev.parentToolUseId && !seenTools.has(ev.name)) {
            seenTools.add(ev.name);
            toolChips.push(ev.name);
          }
          break;
        case "pipeline_status":
          statusLines.push(ev.text);
          break;
        case "pipeline_widget":
          // Last widget in the turn wins — a turn can replace one it already
          // put up (a status line, then the picker under it).
          widgetEvent = { kind: ev.kind, payload: ev.payload };
          break;
        case "ui":
          // Track the last panel-switch so the hint reflects where the panel
          // ended up (focus is ephemeral — nothing to read back afterward).
          if (ev.event.type === "show") lastShow = ev.event;
          break;
        case "stopped":
          stopped = true;
          break;
        case "error":
          error = { message: ev.message, code: ev.code };
          if (ev.code && TERMINAL_ERROR_CODES.has(ev.code)) {
            // No trailing done on these paths — stop consuming.
            return await finalize();
          }
          break;
        case "done":
          return await finalize();
        // tool_use_progress, tool_use_complete, ui: not part of the visible
        // text reconstruction (ui drives the panel hint, resolved below).
        default:
          break;
      }
    }
  } catch (err) {
    eventTrace.push("THROW");
    error = {
      message: err instanceof Error ? err.message : String(err),
      code: "PIPELINE_THROW",
    };
  }
  return await finalize();

  async function finalizeInner(): Promise<VisibleTurn> {
    const panelHint = resolvePanelHint(lastShow);
    const rendered = widgetEvent
      ? buildRenderedWidget(widgetEvent.kind, widgetEvent.payload)
      : null;
    return {
      assistantText: textParts.join("").trim(),
      statusLines,
      toolChips,
      widget: widgetEvent ? { kind: widgetEvent.kind, rendered } : null,
      panelHint,
      error,
      stopped,
      eventTrace,
    };
  }
  // Small indirection so the early `return finalize()` calls read cleanly.
  function finalize(): Promise<VisibleTurn> {
    return finalizeInner();
  }
}
