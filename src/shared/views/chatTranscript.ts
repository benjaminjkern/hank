// The chat panel's transcript payload — one page of a session's persisted
// ChatMessage rows as the segments the chat renders. Built by
// loadChatTranscriptPage (server/views/chatTranscript.ts); the client store
// extends these with what only a live stream carries.

export type AttachmentView = {
  attachmentId: string;
  fileName: string;
  mediaKind: string;
};

export type ToolSegment = {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  status: "pending" | "done" | "error";
  result?: string;
  // Nested sub-agent activity for this tool, populated from the
  // `ChatMessage.traces` JSON column. Same Segment[] shape (text + tool),
  // so the renderer recurses naturally. Absent for leaf tools (no
  // sub-agent activity captured).
  children?: Segment[];
};

export type TextSegment = { kind: "text"; text: string };

// UI-only segments emitted by the deterministic procedures, not
// by the LLM. Persisted in ChatMessage.content as `pipeline_status` /
// `pipeline_widget` blocks. On the model side, loadSessionMessages RENDERS
// these to plain text on replay (Anthropic rejects the raw block types) so
// Hank remembers what it showed; this UI path renders them distinctly from
// regular text instead — status lines as a chip/divider, widgets via
// PipelineWidgetSlot from message history (so they survive refresh without
// the synthetic-tool_use trick).
export type StatusSegment = { kind: "status"; text: string };
export type WidgetSegment = {
  kind: "widget";
  toolUseId: string;
  widgetKind: string;
  payload: unknown;
};
// A run that threw. Persisted as a `run_error` block by runUserMessage; renders
// as a collapsed "something went wrong" row that expands to `detail`.
export type ErrorSegment = { kind: "error"; detail: string };

export type Segment =
  TextSegment | ToolSegment | StatusSegment | WidgetSegment | ErrorSegment;

// One negotiation-panel edit that rode along with a user message (the
// `panel_edits` snapshot block) — rendered as an attachment-style chip.
export type PanelEditView = {
  title: string;
  companyName: string | null;
  verdict: string;
};

export type MessageView = {
  id: string;
  role: "user" | "assistant";
  createdAt: string;
  segments: Segment[];
  attachments?: AttachmentView[];
  panelEdits?: PanelEditView[];
  // True when this assistant turn was cut off (Stop, a dropped socket, or a
  // mid-stream fault). Drives the "interrupted" pill in the chat UI. Always
  // undefined on user rows.
  stoppedByUser?: boolean;
};

export type ChatTranscriptPage = {
  messages: MessageView[];
  // Older rows exist before the first message on this page.
  hasMore: boolean;
  // The request named a valid `before` cursor — a "load older" page rather
  // than the session's newest rows.
  isPaging: boolean;
};
