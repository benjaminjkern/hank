// Cross-layer contracts: the vocabularies Hank's tools, the chat runner, and the
// deterministic layer all speak. Kept out of agent/tools/lib/ (which is abstract
// TOOL infrastructure) because non-tool producers emit these too.

export type { UiEvent } from "./uiEvent";
export type { EntryTarget } from "./entryTarget";
export type {
  StreamEventOf,
  StreamEvent,
  TurnEvent,
  TurnDone,
  LoopEvent,
  ChatTurnRunner,
  WidgetKind,
} from "./events";
export { statusEvent, widgetEvent, yieldUiEvents } from "./events";
export type { RunContext, RunTrace } from "./runContext";
