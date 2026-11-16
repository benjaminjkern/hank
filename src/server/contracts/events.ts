// The server-side turn vocabulary, layered on the chat stream's wire format in
// src/shared/chatStream.ts (StreamEvent / LoopEvent / UiEvent live there, shared
// with the client):
//
//   Say             how anything below the chat route talks to the user: hand an
//                   event to `say` and await it. Nothing yields events; a
//                   procedure is a plain async function whose result is what it
//                   returns.
//   UiSay/StatusSay the narrower `say`s that may only move the panel or add a
//                   status line — what a tool gets (see tools/lib/types.ts).
//
// NOTE: the `pipeline_status` / `pipeline_widget` variant names are deliberately
// not renamed — they're persisted verbatim in ChatMessage.content JSON.

import type { StreamEvent, UiEvent } from "@/shared/chatStream";
import type { WidgetKind } from "@/shared/widgetKinds";

// ---------------------------------------------------------------------------
// The product instantiations
// ---------------------------------------------------------------------------

// How anything below the chat route talks to the user: hand an event to `say`
// and await it. The await is the contract — it resolves once the event is
// persisted (recordTranscript) and sent, so a procedure that writes rows of its
// own after narrating can't land them ahead of what it said. Procedures that
// narrate take `say` on their args and pass it straight through to whatever
// they call, the same way they pass RunContext.
//
// The chat route's own `say` receives LoopEvent instead — the bare terminal
// `done` exists only at that boundary.
export type Say<E = StreamEvent> = (event: E) => Promise<void>;

// A `say` for a consumer with nothing to wait on — an SSE writer, a collector:
// it runs `handle` and resolves.
// The two events that only SHOW something — a panel move and a status line —
// as their own `say`s, so a caller that may show but never ask (a tool) can be
// typed to exactly that.
type UiEventSaid = { type: "ui"; event: UiEvent };
type StatusEventSaid = { type: "pipeline_status"; text: string };
export type UiSay = Say<UiEventSaid>;
export type StatusSay = Say<StatusEventSaid>;

export function sayTo<E = StreamEvent>(handle: (event: E) => void): Say<E> {
  return (event) => {
    handle(event);
    return Promise.resolve();
  };
}

// ---------------------------------------------------------------------------
// Constructors for the two events the deterministic layer emits by hand
// ---------------------------------------------------------------------------

// Every procedure that narrates or asks uses these, so there is one copy of
// each shape. They live with the type they construct.
//
// A caller says these and is done: recordTranscript persists what goes out.

// Deterministic machine narration ("Pulling in roles for 3 companies…"), as
// opposed to a plain `text` event. The difference is what the MODEL reads back:
// a status line replays as a system record of what the user was shown, while
// text replays as Hank's own prose (see session/uiProvenance.ts). So narrate
// with this whenever the words are the machine's rather than his.
export function statusEvent(text: string): StatusEventSaid {
  return { type: "pipeline_status", text };
}

// Say a batch of panel-sync events, in order. Pure vocabulary adapter — it
// knows nothing about what's being shown, which is why it lives here and not
// with the domain read that produced the events.
export async function sayUiEvents(
  say: UiSay,
  events: UiEvent[],
): Promise<void> {
  for (const event of events) {
    // eslint-disable-next-line no-await-in-loop -- each event is said in order; the await is the persistence ordering, not a query
    await say({ type: "ui", event });
  }
}

export function widgetEvent(kind: WidgetKind, payload: unknown): StreamEvent {
  const toolUseId = `pipeline-${kind}-${crypto.randomUUID()}`;
  return { type: "pipeline_widget", toolUseId, kind, payload };
}
