// The chat transcript store: where a session lives, how it replays into the
// model's context, and how each turn is written back. Lifted out of
// agent/runtime/ — the runner drives a turn, it doesn't own the transcript.

export { getOrCreateActiveSession, endActiveSessions } from "./chatSession";
export { loadSessionMessages } from "./loadTranscript";
export { serializeTranscript, type StoredMessage } from "./serializeTranscript";
export {
  appendUserMessage,
  appendAssistantMessage,
  appendPipelineActivity,
  appendRunError,
  appendToolResultMessage,
} from "./appendMessages";
export { narrateStatus, narrateText } from "./narrate";
