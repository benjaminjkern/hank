// Cross-layer contracts: the server-side vocabularies Hank's tools, the chat
// runner, and the deterministic layer all speak. The wire events the client also
// reads live in src/shared/chatStream.ts; RunContext in platform/runContext.ts.

export type {
  Entry,
  ProfileGaps,
  Segment,
  StepArgs,
  StepOutcome,
} from "./entry";
export type { Say, StatusSay, UiSay } from "./events";
export { statusEvent, widgetEvent, sayUiEvents, sayTo } from "./events";
