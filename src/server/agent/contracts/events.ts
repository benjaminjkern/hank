// The event vocabularies every layer speaks, in one place.
//
// Four names, one union underneath:
//
//   StreamEventOf<TUi, TKind>  the DOMAIN-FREE core. Parametric over the only two
//                              payloads a stream carries without ever reading
//                              them: the panel event and the widget-kind tag.
//   StreamEvent                that core, resolved to this product's payloads.
//                              The one name agent/runtime/ writes — it says what
//                              a stream carries and nothing about companies,
//                              jobs, or profiles, which is the point. (Runtime
//                              can't be handed the bare parametric form: what it
//                              yields has to be assignable to what the domain
//                              consumes, and `unknown` is not a `UiEvent`.)
//   TurnEvent                  StreamEvent plus `done`. What every procedure and
//                              widget dispatcher yields.
//   LoopEvent                  StreamEvent plus a BARE `done`, SSE-facing: by the
//                              time the stream reaches the client, the turn's
//                              outcome has already been acted on.
//
// The split is the whole point. `runtime/` executes turns and must not know what
// a company is; `procedures/` and `widgets/` produce the actual product events.
// Both need one wire format, so it lives here in contracts/ — imported by name,
// interpreted only on the domain side.
//
// NOTE: the `pipeline_status` / `pipeline_widget` variant names are deliberately
// NOT renamed. They're persisted verbatim in ChatMessage.content JSON and read by
// the client, so changing them would need a data migration and would break replay
// of existing history. "Pipeline" survives as a storage name only — there is no
// pipeline layer in the code anymore.

import type { WidgetKind } from "@/lib/widgetKinds";

import type { EntryTarget } from "./entryTarget";
import type { RunContext } from "./runContext";
import type { UiEvent } from "./uiEvent";

// Widget kinds the deterministic layer can render. The union is owned by
// src/lib/widgetKinds.ts — single source of truth shared with the client. Add a
// new kind there, then add its payload schema in
// src/components/Chat/widgets/types.ts in the same commit.

export type { WidgetKind };

// ---------------------------------------------------------------------------
// The domain-free core
// ---------------------------------------------------------------------------

// `parentToolUseId`, when set, marks the event as a sub-agent trace emission —
// the client routes it into the named parent tool chip's `children` (expandable
// panel) instead of appending as a top-level segment. Same shapes, same
// dispatcher (applyEvent); just nested.
//
// The two parameters exist to say, in the type, that nothing in this union is
// ever inspected — a stream carries them from producer to client untouched.
export type StreamEventOf<TUi, TWidgetKind extends string> =
  // A new assistant ChatMessage row is opening. Every content event after it
  // belongs to that row until the next boundary, and `messageId` is the row's
  // PRE-MINTED `ChatMessage.id` — so the bubbles the client paints live carry
  // the same ids and the same grouping as the rows the end-of-turn reconcile
  // loads back. Without it the client had one bubble per send() while the DB had
  // one row per narration, and every run ended by visibly re-shuffling itself.
  // Re-entering an id already opened is fine and expected (a turn's tool loop
  // alternates between its own row and the follow-up widget/status rows).
  | { type: "message_start"; messageId: string }
  | { type: "text"; text: string; parentToolUseId?: string }
  | {
      type: "tool_use_start";
      name: string;
      toolUseId: string;
      input: unknown;
      parentToolUseId?: string;
    }
  | {
      type: "tool_use_progress";
      toolUseId: string;
      label: string;
      parentToolUseId?: string;
    }
  | {
      type: "tool_use_complete";
      toolUseId: string;
      result: string;
      error?: boolean;
      parentToolUseId?: string;
      // When true, completing this tool may have changed entities the user is
      // currently looking at. Populated server-side from the tool's
      // `affectsViewedState` metadata; the client uses it to schedule a
      // debounced mid-turn refetch.
      affectsViewedState?: boolean;
    }
  | { type: "ui"; event: TUi }
  // A deterministic status line ("Running shortlist over N jobs"). Streamed live
  // and persisted as a `pipeline_status` block, then stripped from the LLM's
  // replay history — on replay loadSessionMessages renders it as a provenance
  // note in a non-assistant channel (a `role:"system"` message) so the model
  // remembers what narration the user saw without mistaking it for its own prose
  // (see uiProvenance.ts).
  | { type: "pipeline_status"; text: string }
  // Transient widget — streams live over SSE so the client's chatStore can
  // populate `currentWidget` and show it before any history refetch. Emitted
  // alongside (or before) the `pipeline_widget` persistence block; the two paths
  // converge in the client's dispatcher (history wins over transient).
  | {
      type: "widget";
      toolUseId: string;
      kind: TWidgetKind;
      payload: unknown;
    }
  // The persisted form. The client appends a WidgetSegment to message history;
  // on refresh the segment is re-loaded from the `pipeline_widget` content block.
  | {
      type: "pipeline_widget";
      toolUseId: string;
      kind: TWidgetKind;
      payload: unknown;
    }
  // Transient mid-turn "the panel is stale, refetch it" ping. No payload, not
  // persisted. Yielded right after a mid-run write that changes dashboard
  // buckets or a viewed entity, so the right panel updates without waiting for
  // the end-of-turn refetch. The client debounces (300ms), so emitting one per
  // item in a loop is cheap.
  | { type: "refresh_viewed_state" }
  | { type: "stopped" }
  | { type: "error"; message: string; code?: string };

// ---------------------------------------------------------------------------
// The product instantiations
// ---------------------------------------------------------------------------

// What a turn reports when it finishes. Both fields are domain outcomes and must
// NOT be merged: `endedCompanyId` means *a company ended* (run the segment wrap,
// once per message no matter how many closed); `wrappedUp` means *bring up
// what's next*, which half a dozen paths set with no company having ended.
export type TurnDone = {
  type: "done";
  wrappedUp: boolean;
  endedCompanyId?: string;
};

// The core resolved to this product. Everything below builds on it, and it's the
// only one of these four names agent/runtime/ uses.
export type StreamEvent = StreamEventOf<UiEvent, WidgetKind>;

// What every procedure, widget dispatcher, and the chat procedure yield.
export type TurnEvent = StreamEvent | TurnDone;

// The SSE stream the chat route serializes to the client. Same events; `done`
// is bare because the turn's outcome was already acted on server-side.
export type LoopEvent = StreamEvent | { type: "done" };

// The chat-turn contract. `procedures/registry/chat/runChatTurn.ts` implements
// it; `runChat` drives it.
//
// "Silent entry" passes "" as userMessage — the turn is a deterministic
// continuation (a picker pick, a wrap) rather than something the user typed, and
// the runner works from `entryTarget` + entity statuses instead.
export type ChatTurnRunner = (
  args: RunContext & {
    sessionId: string;
    // First user message of this turn. "" on silent entry.
    userMessage: string;
    attachmentIds: string[];
    // The user sent with no text because their panel marks ARE the
    // message. Empty text alone means silent entry (the deterministic layer
    // drives); with this set the turn opens a real user row — the panel-edit
    // blocks are its content — and Hank answers it.
    carriesPanelEdits?: boolean;
    // Set when runWhatsNext's rung-0 gate just came back short: the gatekeeper's
    // read of what's thin in the user's profile (weakest slots + suggested probe
    // questions), so Hank opens on the specifics instead of cold. Only read on a
    // turn where the derived profile-intake signal is set.
    profileGaps?: { missing: string[]; suggestedProbes: string[] };
    // The entity the deterministic state machine should run its arm on this turn,
    // threaded in-memory (never persisted) — supplied on a picker-driven silent
    // entry (dispatchNextCompanyPicker returns it). Undefined on free-text / cold
    // entries, where the runner takes the target from the handoff tool the agent
    // called instead. See EntryTarget.
    entryTarget?: EntryTarget;
  },
) => AsyncGenerator<TurnEvent>;

// ---------------------------------------------------------------------------
// Constructors for the two events the deterministic layer emits by hand
// ---------------------------------------------------------------------------

// The walkthrough state machine and the shortlist rung both narrate and both
// render widgets, and each had its own verbatim copy of these two — one of them
// annotated "mirror the walkthrough state machine's", which is the drift warning
// in comment form. They live with the type they construct.
//
// The caller buffers whatever it yields (alongside any regular `text` events) and
// persists the buffer as ONE assistant message at the end of the pass. That
// single-message persistence keeps related output in one chat bubble and avoids
// the "empty bubble between status and widget" artifact you get when each event
// persists inline.

export function statusEvent(text: string): TurnEvent {
  return { type: "pipeline_status", text };
}

// Stream a batch of panel-sync events into a TurnEvent stream. Pure vocabulary
// adapter — it knows nothing about what's being shown, which is why it lives
// here and not with the domain read that produced the events.
export async function* yieldUiEvents(
  events: UiEvent[],
): AsyncGenerator<TurnEvent> {
  for (const event of events) {
    yield { type: "ui", event };
  }
}

export function widgetEvent(kind: WidgetKind, payload: unknown): TurnEvent {
  const toolUseId = `pipeline-${kind}-${crypto.randomUUID()}`;
  return { type: "pipeline_widget", toolUseId, kind, payload };
}
