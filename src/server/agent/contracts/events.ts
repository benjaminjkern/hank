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
  // PRE-MINTED `ChatMessage.id` — so the bubble the client paints live IS the
  // row the end-of-turn reconcile loads back, and the reconcile repaints
  // nothing. Re-announcing an already-open id is a no-op and expected (a turn's
  // tool loop alternates between its own row and its widget/status rows).
  | { type: "message_start"; messageId: string }
  // The emitter that announced the preceding row (or rows) has WRITTEN them
  // itself, and content from here on belongs to whoever comes next.
  //
  // It exists because recordTranscript persists everything on the stream that
  // nobody else claimed, and a claim needs a way to end — which is also why it
  // never reaches the client: recordTranscript consumes it. It names no id on
  // purpose, since a Hank turn announces up to three rows and releases them
  // together.
  | { type: "message_end" }
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
  // A widget. The client appends a WidgetSegment to message history and
  // PipelineWidgetSlot renders the newest one above the composer — live and
  // after a refresh alike, since recordTranscript writes the matching
  // `pipeline_widget` block as the event goes out.
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
    // First user message of this turn. "" on silent entry. The row for it is
    // already written (runChat's openUserTurn) — this is the text to ROUTE on,
    // and the attachments that rode with it are not this layer's business.
    userMessage: string;
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
    // A synthetic first user turn for a turn nothing else opens: the user
    // clicked something whose whole meaning is "ask me about this", so there's
    // no text to answer and no entity to dispatch on. Setting it makes the turn
    // Hank's (the deterministic layer would otherwise take a silent entry and
    // find nothing to run). Parenthesized so he reads it as an instruction
    // rather than words to echo, and never persisted.
    openingNudge?: string;
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
// A caller yields these and is done: recordTranscript persists what goes out.

// Deterministic machine narration ("Pulling in roles for 3 companies…"), as
// opposed to a plain `text` event. The difference is what the MODEL reads back:
// a status line replays as a system record of what the user was shown, while
// text replays as Hank's own prose (see session/uiProvenance.ts). So narrate
// with this whenever the words are the machine's rather than his.
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
