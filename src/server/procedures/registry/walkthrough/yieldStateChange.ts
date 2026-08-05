import { yieldUiEvents } from "@/server/agent/contracts";
import type { TurnEvent, UiEvent } from "@/server/agent/contracts";

// Yield a deterministic state change's narration as a `pipeline_status` (so the
// chat history records the action verbatim) BEFORE any panel events fire.
// Ordering matters: the status line is part of the assistant message bubble the
// caller persists, and posting a panel event first would split the bubble.
//
// Empty narration is silently skipped — a caller that declined to act (a refused
// switch) surfaces its own refusal message instead.
export async function* yieldStateChange(
  narration: string,
  events: UiEvent[] = [],
): AsyncGenerator<TurnEvent> {
  if (narration.trim().length > 0) {
    yield { type: "pipeline_status", text: narration };
  }
  yield* yieldUiEvents(events);
}
