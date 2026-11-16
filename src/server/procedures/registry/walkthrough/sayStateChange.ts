import { sayUiEvents } from "@/server/contracts";
import type { UiEvent } from "@/shared/chatStream";
import type { Say } from "@/server/contracts";

// Say a deterministic state change's narration as a `pipeline_status` (so the
// chat history records the action verbatim) BEFORE any panel events fire.
// Ordering matters: the status line is part of the assistant message bubble the
// caller persists, and posting a panel event first would split the bubble.
//
// Empty narration is silently skipped — a caller that declined to act (a refused
// switch) surfaces its own refusal message instead.
export async function sayStateChange(
  say: Say,
  narration: string,
  events: UiEvent[] = [],
): Promise<void> {
  if (narration.trim().length > 0) {
    await say({ type: "pipeline_status", text: narration });
  }
  await sayUiEvents(say, events);
}
