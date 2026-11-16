// The chat stream's wire format, generic over the only two payloads it carries
// without reading them: the panel event and the widget-kind tag. The product
// resolves it in contracts/events.ts (`StreamEvent`); the agent loop writes the
// subset it produces (row boundaries, text, tool chips, panel events, status
// lines) without knowing what either payload means.

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
