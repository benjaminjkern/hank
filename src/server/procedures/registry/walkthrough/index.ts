// The walkthrough procedure's public surface: the deterministic state machine
// that drives a company / job / discovery pass when Hank hands off, the user
// submits a widget, or a picker enters silently. `runWalkthrough` is the entry —
// see stateMachine.ts for the arm-by-arm overview.
//
// Import from `@/server/procedures/registry/walkthrough` — never a deep path,
// so the internal file split stays free to move.

export { runWalkthrough } from "./stateMachine";
export type { WalkthroughArgs, WalkthroughResult } from "./types";
