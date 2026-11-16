// The server-side turn vocabulary, layered on the wire format in
// src/shared/chatStream.ts (StreamEvent / LoopEvent / UiEvent live there, shared
// with the client):
//
//   TurnEvent       StreamEvent plus a `done` carrying the turn's outcome. What
//                   every procedure and widget dispatcher yields.
//   TurnDone        that `done`.
//   ChatTurnRunner  the chat-turn contract runChat drives.

import type { RunContext } from "@/server/platform/runContext";
import type { StreamEvent, UiEvent } from "@/shared/chatStream";
import type { WidgetKind } from "@/shared/widgetKinds";

import type { EntryTarget } from "./entryTarget";

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

// What every procedure, widget dispatcher, and the chat procedure yield.
export type TurnEvent = StreamEvent | TurnDone;

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
