// The event vocabularies every layer speaks, in one place.
//
// Three names, one union underneath:
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
//   LoopEvent                  StreamEvent plus a BARE `done`, SSE-facing — the
//                              one place a stream ends. Below the route nothing
//                              sends `done`: a procedure's outcome is its return
//                              value.
//
// Nothing yields these. Every layer hands them to a `Say` callback (below), so a
// procedure is a plain async function whose result is what it returns.
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

import type { StreamEventOf } from "@/server/platform/agentLoop/stream";
import type { WidgetKind } from "@/shared/widgetKinds";

import type { EntryTarget } from "./entryTarget";
import type { UiEvent } from "./uiEvent";
import type { RunContext } from "../platform/runs/runContext";

// Widget kinds the deterministic layer can render. The union is owned by
// src/shared/widgetKinds.ts — single source of truth shared with the client. Add a
// new kind there, then add its payload schema in
// src/client/components/Chat/widgets/types.ts in the same commit.

export type { WidgetKind, StreamEventOf };

// ---------------------------------------------------------------------------
// The product instantiations
// ---------------------------------------------------------------------------

// The core resolved to this product. Everything below builds on it, and it's the
// only one of these names agent/runtime/ uses.
export type StreamEvent = StreamEventOf<UiEvent, WidgetKind>;

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
export function sayTo<E = StreamEvent>(handle: (event: E) => void): Say<E> {
  return (event) => {
    handle(event);
    return Promise.resolve();
  };
}

// What one chat turn reports when it finishes. Both company fields are domain
// outcomes and must NOT be merged: `endedCompanyId` means *a company ended*
// (run the segment wrap, once per message no matter how many closed);
// `wrappedUp` means *bring up what's next*, which half a dozen paths set with
// no company having ended. `stopped` means the user hit Stop mid-turn — stop
// driving turns.
export type ChatTurnOutcome = {
  wrappedUp: boolean;
  endedCompanyId?: string;
  stopped?: boolean;
};

// The SSE stream the chat route serializes to the client. Same events; `done`
// is bare because the turn's outcome was already acted on server-side.
export type LoopEvent = StreamEvent | { type: "done" };

// The chat-turn contract. `procedures/registry/chat/runChatTurn.ts` implements
// it; `runChat` drives it. It narrates through `say` and returns its outcome.
//
// "Silent entry" passes "" as userMessage — the turn is a deterministic
// continuation (a picker pick, a wrap) rather than something the user typed, and
// the runner works from `entryTarget` + entity statuses instead.
export type ChatTurnRunner = (
  args: RunContext & {
    sessionId: string;
    say: Say;
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
) => Promise<ChatTurnOutcome>;

// ---------------------------------------------------------------------------
// Constructors for the two events the deterministic layer emits by hand
// ---------------------------------------------------------------------------

// The walkthrough state machine and the shortlist rung both narrate and both
// render widgets, and each had its own verbatim copy of these two — one of them
// annotated "mirror the walkthrough state machine's", which is the drift warning
// in comment form. They live with the type they construct.
//
// A caller says these and is done: recordTranscript persists what goes out.

// Deterministic machine narration ("Pulling in roles for 3 companies…"), as
// opposed to a plain `text` event. The difference is what the MODEL reads back:
// a status line replays as a system record of what the user was shown, while
// text replays as Hank's own prose (see session/uiProvenance.ts). So narrate
// with this whenever the words are the machine's rather than his.
export function statusEvent(text: string): StreamEvent {
  return { type: "pipeline_status", text };
}

// Say a batch of panel-sync events, in order. Pure vocabulary adapter — it
// knows nothing about what's being shown, which is why it lives here and not
// with the domain read that produced the events.
export async function sayUiEvents(say: Say, events: UiEvent[]): Promise<void> {
  for (const event of events) {
    // eslint-disable-next-line no-await-in-loop -- each event is said in order; the await is the persistence ordering, not a query
    await say({ type: "ui", event });
  }
}

export function widgetEvent(kind: WidgetKind, payload: unknown): StreamEvent {
  const toolUseId = `pipeline-${kind}-${crypto.randomUUID()}`;
  return { type: "pipeline_widget", toolUseId, kind, payload };
}
