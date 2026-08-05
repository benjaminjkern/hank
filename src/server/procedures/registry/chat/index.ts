// The chat procedure's public surface: what one user message means, start to
// finish. `runtime/runUserMessage.ts` opens the run and hands straight to this.
//
// Import from `@/server/procedures/registry/chat`, not a deep path — the file
// split inside stays free to move.
//
// `runChat` is the entry. `runChatTurn` is exported only because the offline
// scenario harness drives a single turn in isolation (scripts/scenarios/lib.ts);
// in the app nothing but runChat should be calling it.

export { runChat, type ChatArgs } from "./runChat";
export { runChatTurn } from "./runChatTurn";
