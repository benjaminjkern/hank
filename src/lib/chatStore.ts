"use client";

import { create } from "zustand";

import { reportClientEvent } from "@/lib/clientEvents";
import { withImpersonate } from "@/lib/impersonation";
import type { DocumentsSubPage, PanelMode } from "@/lib/panelMode";
import type { WidgetKind } from "@/lib/widgetKinds";
import type {
  CompanyJobView,
  FocusedCompanyView as ServerFocusedCompanyView,
  FocusedJobView as ServerFocusedJobView,
  FocusedOpportunityView as ServerFocusedOpportunityView,
  ShortAnswer,
} from "@/server/agent/tools/lib/types";
import type { ApplicationView } from "@/server/views/application";
import type { DiscoveryListView } from "@/server/views/discoveryList";
import type { PanelView } from "@/server/views/panelView";
import type { ShortlistBoardView } from "@/server/views/shortlistBoard";

export type { CompanyJobView };

export type ToolSegment = {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  status: "pending" | "done" | "error";
  progressLabel?: string;
  result?: string;
  // Nested sub-agent activity captured under this tool. Same Segment[] shape
  // — text + tool, recursively expandable. Built live from streaming
  // `parentToolUseId`-tagged events and hydrated on reload from
  // ChatMessage.traces. Absent for leaf tools.
  children?: Segment[];
};

// Assistant turns interleave text and tool calls; preserving order matters so
// "I'll check X" appears above the chip and "based on the result..." below.
// `job-ref` is an inline pointer to a JobInteraction, persisted in message
// text as `<job-ref jobId="X" label="..."/>` and split out at render time.
// The label is captured at send time so chips stay readable even after the
// linked job is renamed or hard-deleted.
// `status` is a UI-only line emitted by the deterministic pipeline state
// machine (e.g. "Running shortlist over 15 jobs"). Persisted in
// ChatMessage.content as a `pipeline_status` block and stripped before the
// LLM sees it. `widget` is the persisted form of a pipeline widget (e.g.
// shortlist_proposal) — replaces the legacy synthetic propose_shortlist_auto
// tool_use trick. PipelineWidgetSlot reads the latest widget segment out of
// message history; on refresh, the widget keeps rendering without a synthetic
// tool result lying around in chat history.
export type StatusSegment = { kind: "status"; text: string };
export type WidgetSegment = {
  kind: "widget";
  toolUseId: string;
  widgetKind: string;
  payload: unknown;
};
// A run that threw — rendered as a collapsed "something went wrong" row that
// expands to the raw `detail`. Pushed live off the SSE `error` event AND
// persisted server-side as a `run_error` block, so the reconcile that the
// following `done` triggers finds the same segment instead of replacing it away.
export type ErrorSegment = { kind: "error"; detail: string };

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "job-ref"; jobId: string; label: string }
  | ToolSegment
  | StatusSegment
  | WidgetSegment
  | ErrorSegment;

export type AttachmentView = {
  attachmentId: string;
  fileName: string;
  mediaKind: string;
};

// One shortlist-board edit that rode along with a user message (the
// `panel_edits` snapshot block) — rendered as an attachment-style chip.
export type PanelEditView = {
  title: string;
  companyName: string | null;
  verdict: string;
};

export type MessageView = {
  id: string;
  role: "user" | "assistant";
  createdAt?: string;
  segments: Segment[];
  attachments?: AttachmentView[];
  panelEdits?: PanelEditView[];
  // True when this assistant turn was interrupted by the Stop button. Drives
  // the "Stopped by user" pill in MessageBubble. Set live via the `stopped`
  // SSE event and persisted via the ChatMessage.stoppedByUser column.
  stoppedByUser?: boolean;
};

type PendingAttachment = {
  tempId: string;
  fileName: string;
  fileSize: number;
  status: "uploading" | "uploaded" | "error";
  attachmentId?: string;
  error?: string;
};

// Documents navigation. The sub-page lives in the store rather than
// DocumentsView's local state because it's part of the panel's addressable
// position — panelUrl reads it, and a URL restore writes it.
type DocumentsNav = {
  subPage: DocumentsSubPage;
  // jobInteractionIds of the artifact blocks expanded on the "artifacts" sub-page.
  expandedArtifacts: string[];
};

// Aliases so existing UI imports keep working. The underlying types live in
// the shared tools/lib/types module and are used by both server and client.
export type FocusedCompanyView = ServerFocusedCompanyView | null;
type FocusedJobView = ServerFocusedJobView | null;
type FocusedOpportunityView = ServerFocusedOpportunityView | null;

export type DashboardCompany = {
  companyId: string;
  companyName: string;
  // Resolved logo (override or auto-derived). Same chip pattern as the
  // company page header / job detail header.
  logoUrl: string;
  // Live statuses only — CLOSED / PAUSED / BLOCKED are pre-split server-side
  // onto `DashboardView.closed` / `.paused` / `.blocked`.
  status:
    "NEW" | "READY" | "APPLYING" | "IN_FLIGHT" | "IN_PROCESS" | "CAUGHT_UP";
  // ISO timestamp of the most recent successful scrape, or null if never
  // scanned. Drives the dashboard's empty-row label.
  lastScrapedJobsAt: string | null;
  // Jobs that were on the careers page at the most recent scan (not the
  // ever-seen total). Zero when the company has never been scanned.
  recentJobCount: number;
  jobInteractions: Array<{
    jobInteractionId: string;
    jobId: string;
    title: string;
    sourceUrl: string | null;
    status: string;
    location: string | null;
    compensation: string | null;
    department: string | null;
    employmentType: string | null;
    lastEventType: string | null;
    lastEventAt: string | null;
    // Application date for APPLIED jobs aging without a response (drives the
    // escalating pill color + "Applied …" caption); null otherwise.
    appliedAt: string | null;
  }>;
};

export type DashboardClosedCompany = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  closeReason: string | null;
  closeNote: string | null;
};

export type DashboardPausedCompany = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  pauseReason: string | null;
  pauseNote: string | null;
};

// Company set aside because its board couldn't be read (BLOCKED). Technical, not
// a fit judgment — revivable. Mirrors the server DashboardBlockedCompany.
export type DashboardBlockedCompany = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  blockReason: string | null;
  blockNote: string | null;
};

export type DashboardOpportunityJob = {
  jobInteractionId: string;
  jobId: string;
  title: string;
  // JobInteractionStatus — including PITCHED for unaffiliated/recruiter-pitched rows.
  status:
    | "PITCHED"
    | "NEW"
    | "SCANNED"
    | "SHORTLISTED"
    | "CLOSED"
    | "APPLIED"
    | "RESPONDED"
    | "INTERVIEW_SCHEDULED"
    | "INTERVIEW_DEBRIEF"
    | "WAITING_ON_RESPONSE"
    | "OFFERED"
    | "REJECTED"
    | "DELISTED"; // posting taken down (detected on re-scrape)
  companyDisplayName: string | null;
  companyId: string | null;
  logoUrl: string | null;
  // Application date for an APPLIED pitched role aging without a response
  // (drives the escalating pill color + "Applied …" caption); null otherwise.
  appliedAt: string | null;
  // When the role ended, for terminal rows (DELISTED reaches the dashboard;
  // CLOSED/REJECTED are filtered off it). Null for non-terminal rows.
  closedAt: string | null;
};

export type DashboardOpportunity = {
  opportunityId: string;
  label: string;
  status: "OPEN" | "SCREENING" | "AWAITING";
  nextStepAt: string | null;
  primaryContact: { name: string; agency: string | null } | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  jobs: DashboardOpportunityJob[];
};

export type DashboardView = {
  companies: DashboardCompany[];
  closed: DashboardClosedCompany[];
  paused: DashboardPausedCompany[];
  blocked: DashboardBlockedCompany[];
  opportunities: DashboardOpportunity[];
  total: number;
  isAdmin: boolean;
  openAdminNoteCount: number;
  openDeletionRecCount: number;
};

type State = {
  hydrated: boolean;
  messages: MessageView[];
  hasMoreMessages: boolean;
  loadingOlder: boolean;
  streaming: boolean;
  // True when a turn's SSE stream ended abnormally (connection dropped /
  // backgrounded before the terminal `done`). Drives a soft "connection
  // dropped — catching up…" notice instead of a hard `[error: …]` bubble, and
  // is cleared the moment a reconcile (on return-to-app / online) or a fresh
  // send succeeds. The turn's real progress is safe in the DB regardless.
  streamInterrupted: boolean;
  // True when the SERVER reports a runUserMessage still in flight for this
  // session while this client has no live stream reading it — i.e. the run is
  // DRAINING after an SSE drop / refresh / ALREADY_STREAMING bounce (the chat
  // route deliberately finishes work for a gone client, up to MAX_RUN_MS).
  // Set from the `runActive` field on /api/session responses. Drives the
  // "Hank is still working" notice in ChatPanel and the poll loop that keeps
  // refetching until the run completes — without it, a reconcile mid-drain
  // silently replaced the streamed processing UI with the partial persisted
  // turn and nothing ever showed the finished result (the "it removed those
  // UI elements and gave no indicator" bug; a refresh was the only fix).
  serverRunActive: boolean;
  // A send() requested while a turn is already streaming — queued instead of
  // dropped, and flushed automatically when the current turn ends. This is what
  // makes a pipeline-widget button click (or a fast second message) land mid-
  // stream instead of silently no-op'ing — the bug where pressing Revive /
  // Keep / a picker did nothing for seconds (worse on the slower DeepSeek path)
  // and only a refresh unstuck it. One slot, last-write-wins.
  queuedSend: { text: string } | null;
  // Stop state. A single Stop press aborts the whole run server-side via POST
  // /api/chat/stop; the server persists whatever streamed and emits the terminal
  // stopped+done events, which the client reads normally. `stopController` is the
  // AbortController on the in-flight /api/chat fetch, kept only as a fallback —
  // we abort it locally if the stop POST itself fails. No two-tier / second-press
  // escalation.
  stopController: AbortController | null;
  // What's currently in the right panel. User navigation and the agent's
  // show_* / pipeline panel events drive these; focus is ephemeral, so there's
  // no persisted focus slot behind them.
  viewedCompany: FocusedCompanyView;
  viewedJob: FocusedJobView;
  viewedOpportunity: FocusedOpportunityView;
  viewedBoard: ShortlistBoardView | null;
  viewedApplication: ApplicationView | null;
  viewedDiscovery: DiscoveryListView | null;
  // Board rows the user changed since their last chat message — rendered as a
  // composer chip; the server derives the authoritative relay at send time.
  pendingBoardEditCount: number;
  // Same, for discovery marks. Kept as its own count rather than folded into
  // the board's: the composer names which surface the pending edits are on.
  pendingDiscoveryMarkCount: number;
  panelMode: PanelMode;
  // Who moved the panel last, which is what decides whether the URL writer
  // pushes a history entry or rewrites the current one: a user gesture is a
  // navigation worth backing out of, while a panel move the agent made (or one
  // the URL itself asked for) is not. Read only by PanelUrlSync.
  panelMovedBy: "user" | "agent" | "url";
  // Sub-page + expanded blocks for the Documents view. See DocumentsNav.
  documentsNav: DocumentsNav;
  // Bumped by refreshViewedEntities. Documents has no viewed-entity slot to
  // refetch — it owns its payload — so this counter is what tells it to reload
  // when the agent changed something it shows.
  documentsEpoch: number;
  dashboard: DashboardView | null;
  rightCollapsed: boolean;
  // Which panel is active in narrow-viewport (single-panel) mode. Ignored
  // above the `narrow` breakpoint where both panels render side-by-side.
  activePanel: "chat" | "right";
  // Right tab has unseen agent-driven changes (focus/panel_mode events
  // arrived mid-turn while user was on chat). Cleared when user lands on
  // the right tab — either manually or via end-of-turn auto-switch.
  panelBadge: boolean;
  pendingAttachments: PendingAttachment[];
  // Hard-blocking modal trigger. Set when the user has no key, when the saved
  // key was rejected mid-turn, or when Anthropic returned a credit-balance
  // error. `null` means chat is unblocked. The modal is the single fix path —
  // we suppress the matching inline error message so it doesn't double up.
  apiKeyBlocker: ApiKeyBlockerReason | null;
  // Non-null only when an admin opened /admin/session/[sessionId] — the
  // session id of the user being inspected. Every read-side fetch in this
  // store appends `?impersonate={id}` so the server returns that user's data
  // instead of the caller's. Writes are hidden in the UI and the server
  // refuses any write that carries the param.
  impersonateSessionId: string | null;
  // When non-null, the composer should adopt this text and the store clears
  // the field. Used by the ALREADY_STREAMING reject path so the user doesn't
  // lose their typed message when the server bounces a concurrent send.
  restoreComposerText: string | null;
  // The active pipeline widget (sticky bar above composer). Set when an SSE
  // `widget` event arrives; cleared on the next user send (the submission is
  // implicit in the user message — the widget shouldn't linger after its
  // answer ships). Only one widget is active at a time.
  currentWidget: {
    toolUseId: string;
    kind: WidgetKind;
    payload: unknown;
  } | null;
};

export type ApiKeyBlockerReason =
  | "missing" // Anthropic key missing (vision path, via the résumé route)
  | "invalid" // Anthropic key rejected mid-turn (vision path)
  | "no_credit" // Anthropic wallet dry (vision path)
  | "missing_deepseek" // DeepSeek key missing — the primary chat blocker
  | "invalid_deepseek" // DeepSeek key rejected mid-turn (chat)
  | "deepseek_no_credit"; // DeepSeek wallet dry (chat)

type Actions = {
  hydrate: () => Promise<void>;
  refetchSession: () => Promise<void>;
  refetchDashboard: () => Promise<void>;
  refreshViewedEntities: () => Promise<void>;
  // Pull the canonical turn state (messages + panel + dashboard) from the DB
  // in one shot. The DB is the source of truth — every turn persists
  // per-step and partials flush on abort — so this fully repairs the UI after
  // an SSE stream that the client missed the terminal `done` for (backgrounded
  // tab / suspended PWA / dropped connection). Called by the return-to-app
  // listeners in ChatHydrator and the abnormal-stream-end paths in send().
  reconcileFromServer: () => void;
  loadOlderMessages: () => Promise<void>;
  send: (text: string) => Promise<void>;
  // Single-press stop: POST /api/chat/stop → the server aborts the run and emits
  // the terminal stopped+done. Falls back to aborting the local fetch only if the
  // POST fails. No-op when not streaming.
  stop: () => Promise<void>;
  stageFiles: (files: File[]) => void;
  removePending: (tempId: string) => void;
  newChat: () => Promise<void>;
  toggleRightCollapsed: () => void;
  setActivePanel: (panel: "chat" | "right") => void;
  // View-only actions — pure right-panel navigation, no server state.
  viewDashboard: () => void;
  // Pure view change to the documents page — does NOT touch session focus.
  // Resets the Documents view to its index (a fresh top-level navigation).
  viewDocuments: () => void;
  // Pure view change to the analytics page — does NOT touch session focus.
  viewAnalytics: () => void;
  // Documents sub-page router. setDocumentsSubPage swaps the visible sub-page;
  // toggleDocumentsArtifact expands/collapses a job block (persisted across
  // unmount).
  setDocumentsSubPage: (subPage: DocumentsSubPage) => void;
  toggleDocumentsArtifact: (jobInteractionId: string) => void;
  // Put a whole panel state on screen at once, as loaded from a URL — the seed
  // the shell hands ChatHydrator, and what a Back/Forward press applies.
  showPanelView: (view: PanelView) => void;
  // Load the panel a path names and show it. The pull half of showPanelView.
  viewPanelPath: (path: string) => Promise<void>;
  viewCompany: (companyId: string) => Promise<void>;
  viewJob: (jobId: string) => Promise<void>;
  viewOpportunity: (opportunityId: string) => Promise<void>;
  viewShortlistBoard: (companyId: string) => Promise<void>;
  viewApplication: (jobId: string) => Promise<void>;
  replaceViewedApplication: (next: ApplicationView) => void;
  // One board-row edit from the panel: POSTs the stance (persisted
  // immediately — the board is DB truth), refreshes the board payload, and
  // bumps the pending-edit chip. The relay to Hank is server-derived at the
  // next send; this never touches the composer.
  editShortlistBoard: (
    companyId: string,
    jobId: string,
    verdict: "pick" | "borderline" | "pass" | "undecided",
    reason?: string,
  ) => Promise<void>;
  // The discovery list's equivalent: POSTs one candidate's mark, which decides
  // nothing until Hank's commit_discovery.
  markSuggestion: (suggestionId: string, mark: "add" | "pass") => Promise<void>;
  // Optimistic patch for the currently-viewed job's JobInteraction fields.
  // Used by JobDetailView's edit-in-place so the textarea reflects the latest
  // value while the PATCH round-trips. Replaced with canonical state when the
  // server response lands. No-op if no job is viewed or the id doesn't match.
  patchViewedJobInteraction: (
    jobId: string,
    patch: Partial<{
      coverLetter: string | null;
      shortAnswers: ShortAnswer[] | null;
      coverLetterReuse: boolean | null;
      shortAnswersReuse: (boolean | null)[] | null;
    }>,
  ) => void;
  replaceViewedJob: (jobId: string, next: ServerFocusedJobView) => void;
  // Trigger / dismiss the blocking key modal. Setting null is the only way
  // out of the modal — call it after a successful saveApiKey + session
  // refetch confirms the key is good.
  setApiKeyBlocker: (reason: ApiKeyBlockerReason | null) => void;
  // Which user's data this store holds: null = the signed-in user, a session
  // id = that session's owner (set by /admin/session/[sessionId] via
  // ChatHydrator, and every read fetch then carries the impersonate param).
  // Changing it RESETS the store — routes into and out of the admin viewer are
  // client-side navigations, so this module singleton survives them with the
  // previous identity's messages, dashboard and `hydrated` flag intact.
  setImpersonateSessionId: (sessionId: string | null) => void;
};

const initial: State = {
  hydrated: false,
  messages: [],
  hasMoreMessages: false,
  loadingOlder: false,
  streaming: false,
  streamInterrupted: false,
  serverRunActive: false,
  queuedSend: null,
  stopController: null,
  viewedCompany: null,
  viewedJob: null,
  viewedOpportunity: null,
  viewedBoard: null,
  viewedDiscovery: null,
  viewedApplication: null,
  pendingBoardEditCount: 0,
  pendingDiscoveryMarkCount: 0,
  panelMode: "dashboard",
  panelMovedBy: "user",
  documentsNav: { subPage: "index", expandedArtifacts: [] },
  documentsEpoch: 0,
  dashboard: null,
  // A cold load on the dashboard is chat-first with the panel stowed; a URL
  // naming a specific view opens expanded (showPanelView). A manual
  // collapse-toggle sticks after that.
  rightCollapsed: true,
  activePanel: "chat",
  panelBadge: false,
  pendingAttachments: [],
  apiKeyBlocker: null,
  impersonateSessionId: null,
  restoreComposerText: null,
  currentWidget: null,
};

// Map of tempId → AbortController for in-flight uploads. Kept outside state
// because AbortController isn't serializable and shouldn't drive renders.
const uploadAborts = new Map<string, AbortController>();

// Monotonic counter of turn starts (sends) and session resets. refetchSession
// captures it before fetching and DISCARDS its response if the counter moved
// while the request was in flight: a stale /api/session snapshot predates the
// newer turn, so applying it would wipe that turn's optimistic user+assistant
// messages. The symptom this guards against: click a widget button (or send)
// right as Hank finishes → the previous turn's end-of-turn refetch lands after
// the new send started → the chat visibly rolls back, and the live stream then
// routes every event to an assistant message id the array no longer contains,
// so nothing renders (with the thinking shimmer stuck on) until the new turn's
// own done-refetch repairs it.
let turnEpoch = 0;

// ── Draining-run tracking ────────────────────────────────────────────────
// The server finishes a run even after the client's SSE stream is gone (see
// /api/chat — a disconnect only stops enqueueing; the run drains to completion,
// bounded by its 5-minute cap). /api/session reports that via `runActive`, and
// refetchSession arms this poll loop whenever a run is active with no live
// local stream: each tick refetches, so newly persisted progress paints as it
// lands, and the tick that sees `runActive` flip false runs the end-of-turn
// refresh + flushes any queued send (e.g. a widget click that bounced with
// ALREADY_STREAMING). Without this the client had no way to learn the drained
// run existed or finished — the "processing UI vanished with no indicator, had
// to refresh" bug.
const RUN_ACTIVE_POLL_MS = 3_000;
// Tick budget ≈ 6 minutes — outlasts the server's 5-minute run cap with slack.
// Past it, stop claiming "still working" (a server restart lost the in-memory
// registry, or the report is otherwise stale); the next interaction re-syncs.
const RUN_ACTIVE_POLL_MAX_TICKS = 120;
let runActivePollTimer: ReturnType<typeof setTimeout> | null = null;
let runActivePollTicks = 0;

function armRunActivePoll() {
  runActivePollTicks = 0;
  if (runActivePollTimer !== null) return;
  runActivePollTimer = setTimeout(runActivePollTick, RUN_ACTIVE_POLL_MS);
}

function runActivePollTick() {
  runActivePollTimer = null;
  const s = useChatStore.getState();
  if (!s.serverRunActive) return;
  // A local live stream took over (user re-sent and it went through) — its
  // own terminal handling owns the state now; keep ticking quietly so the
  // flag still clears if that turn ends without a refetch seeing it.
  if (s.streaming) {
    runActivePollTimer = setTimeout(runActivePollTick, RUN_ACTIVE_POLL_MS);
    return;
  }
  runActivePollTicks += 1;
  if (runActivePollTicks > RUN_ACTIVE_POLL_MAX_TICKS) {
    useChatStore.setState({ serverRunActive: false });
    return;
  }
  // refetchSession flips serverRunActive false (and runs the completion path)
  // when the server reports the run done; reschedule only while still active.
  void s.refetchSession().finally(() => {
    if (
      useChatStore.getState().serverRunActive &&
      runActivePollTimer === null
    ) {
      runActivePollTimer = setTimeout(runActivePollTick, RUN_ACTIVE_POLL_MS);
    }
  });
}

// The drained run finished: the refetchSession that detected the flip already
// pulled the final messages/focus; mirror the rest of a normal end-of-turn —
// refresh dashboard + viewed entities, then flush a queued send so a widget
// submission that bounced off the busy session finally fires.
function onServerRunFinished() {
  cancelPendingViewedStateRefresh();
  const s = useChatStore.getState();
  void s.refetchDashboard();
  void s.refreshViewedEntities();
  const queued = s.queuedSend;
  if (queued && !s.streaming) {
    useChatStore.setState({ queuedSend: null });
    void s.send(queued.text);
  }
}

export const useChatStore = create<State & Actions>((set, get) => ({
  ...initial,

  async hydrate() {
    if (get().hydrated) return;
    await Promise.all([get().refetchSession(), get().refetchDashboard()]);
    set({ hydrated: true });
  },

  async refetchSession() {
    try {
      const epochAtFetch = turnEpoch;
      const res = await fetch(
        withImpersonate("/api/session", get().impersonateSessionId),
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: MessageView[];
        hasMore: boolean;
        runActive?: boolean;
      };

      // A new turn (or session reset) started while this request was in
      // flight. This snapshot predates it — applying would roll the chat
      // back and orphan the live stream's assistant message. Drop it; the
      // newer turn's own end-of-turn refetch supersedes this one.
      if (epochAtFetch !== turnEpoch) return;

      // `runActive` true while this client itself is mid-stream is just our
      // own run — only a run with no live local stream is a DRAINING run
      // worth surfacing/polling. (The response predating a brand-new local
      // turn is already excluded by the epoch check above.)
      const wasRunActive = get().serverRunActive;
      const runActive = data.runActive === true && !get().streaming;

      const next: Partial<State> = {
        messages: data.messages,
        hasMoreMessages: data.hasMore,
        serverRunActive: runActive,
        // We just pulled the canonical state — any "connection dropped"
        // notice is now resolved.
        streamInterrupted: false,
      };
      // refetchSession deliberately leaves the panel alone — the URL is what
      // says which view is open, seeded server-side before hydrate() runs, and
      // post-hydration the end-of-turn `done` handler and affectsViewedState
      // pings drive refreshViewedEntities, which repaints whatever is on
      // screen by its own id regardless of what the agent was working on.
      set(next);

      // Drain transitions. Arm: the server is still working a run this client
      // isn't reading (dropped stream / refresh / ALREADY_STREAMING bounce) —
      // start polling so newly persisted progress paints and completion is
      // noticed. Finish: the run we were tracking just ended — do the same
      // refresh a normal end-of-turn does and flush any queued send.
      if (runActive && !wasRunActive) armRunActivePoll();
      else if (!runActive && wasRunActive) onServerRunFinished();
    } catch {
      // ignore
    }
  },

  async loadOlderMessages() {
    const { messages, hasMoreMessages, loadingOlder } = get();
    if (!hasMoreMessages || loadingOlder) return;
    const oldest = messages.find((m) => m.createdAt);
    if (!oldest?.createdAt) return;
    set({ loadingOlder: true });
    try {
      const res = await fetch(
        withImpersonate(
          `/api/session?before=${encodeURIComponent(oldest.createdAt)}`,
          get().impersonateSessionId,
        ),
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: MessageView[];
        hasMore: boolean;
      };
      set((s) => ({
        messages: [...data.messages, ...s.messages],
        hasMoreMessages: data.hasMore,
      }));
    } catch {
      // ignore
    } finally {
      set({ loadingOlder: false });
    }
  },

  async refetchDashboard() {
    try {
      const res = await fetch(
        withImpersonate("/api/dashboard", get().impersonateSessionId),
      );
      if (!res.ok) return;
      const data = (await res.json()) as DashboardView;
      set({ dashboard: data });
    } catch {
      // ignore
    }
  },

  // Refresh whatever entity is currently shown in the right panel, by its own
  // id, regardless of whether it matches the agent's sticky focus. Needed
  // because the user can be browsing one company while the agent writes to
  // another (or to the same one) — refetchSession only refreshes viewed
  // entities when they match focus, leaving stale data otherwise.
  async refreshViewedEntities() {
    // Documents is the one panel mode with no viewed-entity slot — it fetches
    // its own payload and holds it in component state. Bumping the epoch is
    // how it learns something changed underneath it (a resume Hank attached,
    // an answer he drafted); DocumentsView re-fetches on the change.
    set((s) => ({ documentsEpoch: s.documentsEpoch + 1 }));
    const { viewedCompany, viewedJob, viewedOpportunity } = get();
    const tasks: Promise<void>[] = [];
    const impersonate = get().impersonateSessionId;
    if (viewedCompany) {
      const id = viewedCompany.id;
      tasks.push(
        fetch(withImpersonate(`/api/companies/${id}`, impersonate))
          .then((r) => (r.ok ? r.json() : null))
          .then((data: ServerFocusedCompanyView | null) => {
            if (!data) return;
            set((s) =>
              s.viewedCompany?.id === id ? { viewedCompany: data } : {},
            );
          })
          .catch(() => {}),
      );
    }
    if (viewedJob) {
      const id = viewedJob.id;
      tasks.push(
        fetch(withImpersonate(`/api/jobs/${id}`, impersonate))
          .then((r) => (r.ok ? r.json() : null))
          .then((data: ServerFocusedJobView | null) => {
            if (!data) return;
            set((s) => (s.viewedJob?.id === id ? { viewedJob: data } : {}));
          })
          .catch(() => {}),
      );
    }
    if (viewedOpportunity) {
      const id = viewedOpportunity.id;
      tasks.push(
        fetch(withImpersonate(`/api/opportunities/${id}`, impersonate))
          .then((r) => (r.ok ? r.json() : null))
          .then((data: ServerFocusedOpportunityView | null) => {
            if (!data) return;
            set((s) =>
              s.viewedOpportunity?.id === id ? { viewedOpportunity: data } : {},
            );
          })
          .catch(() => {}),
      );
    }
    const viewedApplication = get().viewedApplication;
    if (viewedApplication) {
      const id = viewedApplication.jobId;
      tasks.push(
        fetch(withImpersonate(`/api/jobs/${id}/application`, impersonate))
          .then((r) => (r.ok ? r.json() : null))
          .then((data: ApplicationView | null) => {
            if (!data) return;
            set((s) =>
              s.viewedApplication?.jobId === id
                ? { viewedApplication: data }
                : {},
            );
          })
          .catch(() => {}),
      );
    }
    const viewedBoard = get().viewedBoard;
    if (viewedBoard) {
      const id = viewedBoard.companyId;
      tasks.push(
        fetch(
          withImpersonate(`/api/companies/${id}/shortlist-board`, impersonate),
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((data: ShortlistBoardView | null) => {
            if (!data) return;
            set((s) =>
              s.viewedBoard?.companyId === id ? { viewedBoard: data } : {},
            );
          })
          .catch(() => {}),
      );
    }
    await Promise.all(tasks);
  },

  reconcileFromServer() {
    // Don't reconcile mid-stream — a live connected turn reconciles itself on
    // `done`, and pulling the DB now would clobber the optimistically-streamed
    // assistant message (refetchSession overwrites `messages` from the DB,
    // which lags the live stream). The return-to-app listeners also guard on
    // this, but guard here too so any caller is safe. `refetchSession` clears
    // `streamInterrupted` on success, so a recovered drop drops the notice.
    if (get().streaming) return;
    cancelPendingViewedStateRefresh();
    void get().refetchSession();
    void get().refetchDashboard();
    void get().refreshViewedEntities();
  },

  stageFiles(files: File[]) {
    if (get().impersonateSessionId) return;
    const newRows: PendingAttachment[] = files.map((f) => ({
      tempId: crypto.randomUUID(),
      fileName: f.name,
      fileSize: f.size,
      status: "uploading",
    }));
    set((s) => ({
      pendingAttachments: [...s.pendingAttachments, ...newRows],
    }));

    newRows.forEach((row, i) => {
      const file = files[i];
      const ctrl = new AbortController();
      uploadAborts.set(row.tempId, ctrl);
      const fd = new FormData();
      fd.append("file", file);
      void fetch("/api/attachments", {
        method: "POST",
        body: fd,
        signal: ctrl.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error ?? `upload failed (${res.status})`);
          }
          const body = (await res.json()) as { attachmentId: string };
          set((s) => ({
            pendingAttachments: s.pendingAttachments.map((p) =>
              p.tempId === row.tempId
                ? { ...p, status: "uploaded", attachmentId: body.attachmentId }
                : p,
            ),
          }));
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          set((s) => ({
            pendingAttachments: s.pendingAttachments.map((p) =>
              p.tempId === row.tempId
                ? {
                    ...p,
                    status: "error",
                    error: err instanceof Error ? err.message : String(err),
                  }
                : p,
            ),
          }));
        })
        .finally(() => {
          uploadAborts.delete(row.tempId);
        });
    });
  },

  removePending(tempId: string) {
    const ctrl = uploadAborts.get(tempId);
    if (ctrl) {
      ctrl.abort();
      uploadAborts.delete(tempId);
    }
    set((s) => ({
      pendingAttachments: s.pendingAttachments.filter(
        (p) => p.tempId !== tempId,
      ),
    }));
  },

  toggleRightCollapsed() {
    // Collapsing the dashboard IS a change of address (/dashboard ⇄ /), so it
    // moves the URL — but by replace rather than push: stowing a panel isn't a
    // navigation the user should have to press Back through.
    set((s) => ({ rightCollapsed: !s.rightCollapsed, panelMovedBy: "agent" }));
  },

  setApiKeyBlocker(reason) {
    set({ apiKeyBlocker: reason });
  },

  setImpersonateSessionId(sessionId) {
    if (get().impersonateSessionId === sessionId) return;
    // Whose data this store holds just changed, so everything in it is stale —
    // and `hydrated` staying true would make the next hydrate() a no-op, so
    // the stale data would never be replaced. Reset to `initial` (which clears
    // `hydrated`) rather than clearing fields piecemeal: a field added later
    // would otherwise silently leak across the identity boundary.
    turnEpoch++; // discard any /api/session response still in flight for the old identity
    set({ ...initial, impersonateSessionId: sessionId });
  },

  setActivePanel(panel) {
    // Landing on the right tab clears the unseen-change badge — whether the
    // user got there via tap, swipe, or the end-of-turn auto-switch.
    set((s) => ({
      activePanel: panel,
      panelBadge: panel === "right" ? false : s.panelBadge,
    }));
  },

  viewDashboard() {
    // Asking for the dashboard is asking to see it — this is what makes the
    // Dashboard breadcrumb land on /dashboard rather than the stowed root.
    set({
      panelMode: "dashboard",
      rightCollapsed: false,
      panelMovedBy: "user",
    });
  },

  viewDocuments() {
    // DocumentsView fetches its own payload on mount, so there's nothing to
    // preload here. A top-level navigation opens the index; a sub-page is
    // reached by its own URL, which goes through setDocumentsSubPage.
    set({
      panelMode: "documents",
      panelMovedBy: "user",
      documentsNav: { subPage: "index", expandedArtifacts: [] },
    });
  },

  viewAnalytics() {
    // AnalyticsView fetches its own payload on mount — nothing to preload.
    set({ panelMode: "analytics", panelMovedBy: "user" });
  },

  setDocumentsSubPage(subPage) {
    set((s) => ({
      documentsNav: { ...s.documentsNav, subPage },
      panelMovedBy: "user",
    }));
  },

  toggleDocumentsArtifact(jobInteractionId) {
    set((s) => {
      const set_ = new Set(s.documentsNav.expandedArtifacts);
      if (set_.has(jobInteractionId)) set_.delete(jobInteractionId);
      else set_.add(jobInteractionId);
      return {
        documentsNav: { ...s.documentsNav, expandedArtifacts: [...set_] },
      };
    });
  },

  showPanelView(view) {
    set((s) => ({
      panelMode: view.panelMode,
      viewedCompany: view.company,
      viewedJob: view.job,
      viewedOpportunity: view.opportunity,
      viewedBoard: view.board,
      viewedDiscovery: view.discovery,
      pendingDiscoveryMarkCount: view.discovery?.pendingMarks ?? 0,
      viewedApplication: view.application,
      pendingBoardEditCount: view.board?.pendingEdits ?? 0,
      documentsNav: { ...s.documentsNav, subPage: view.documentsSubPage },
      // The address says whether the panel shows. Every view but the dashboard
      // is open by definition; `/` is the chat-first stowed one and
      // `/dashboard` its open twin.
      rightCollapsed: !view.panelOpen,
      activePanel: view.panelOpen ? ("right" as const) : ("chat" as const),
      panelMovedBy: "url" as const,
    }));
  },

  async viewPanelPath(path) {
    try {
      const res = await fetch(
        withImpersonate(
          `/api/panel?path=${encodeURIComponent(path)}`,
          get().impersonateSessionId,
        ),
      );
      if (!res.ok) return;
      get().showPanelView((await res.json()) as PanelView);
    } catch {
      // ignore — the panel stays where it was
    }
  },

  async viewCompany(companyId: string) {
    try {
      const res = await fetch(
        withImpersonate(
          `/api/companies/${companyId}`,
          get().impersonateSessionId,
        ),
      );
      if (!res.ok) return;
      const data = (await res.json()) as ServerFocusedCompanyView;
      set({
        viewedCompany: data,
        panelMode: "company-context",
        panelMovedBy: "user",
      });
    } catch {
      // ignore
    }
  },

  async viewJob(jobId: string) {
    try {
      const res = await fetch(
        withImpersonate(`/api/jobs/${jobId}`, get().impersonateSessionId),
      );
      if (!res.ok) return;
      const data = (await res.json()) as ServerFocusedJobView;
      set({ viewedJob: data, panelMode: "job-detail", panelMovedBy: "user" });
    } catch {
      // ignore
    }
  },

  async viewOpportunity(opportunityId: string) {
    try {
      const res = await fetch(
        withImpersonate(
          `/api/opportunities/${opportunityId}`,
          get().impersonateSessionId,
        ),
      );
      if (!res.ok) return;
      const data = (await res.json()) as ServerFocusedOpportunityView;
      set({
        viewedOpportunity: data,
        panelMode: "opportunity-detail",
        panelMovedBy: "user",
      });
    } catch {
      // ignore
    }
  },

  async viewApplication(jobId: string) {
    try {
      const res = await fetch(
        withImpersonate(
          `/api/jobs/${jobId}/application`,
          get().impersonateSessionId,
        ),
      );
      if (!res.ok) return;
      const data = (await res.json()) as ApplicationView;
      set({
        viewedApplication: data,
        panelMode: "application",
        panelMovedBy: "user",
      });
    } catch {
      // ignore
    }
  },

  replaceViewedApplication(next) {
    set((s) =>
      s.viewedApplication?.jobId === next.jobId
        ? { viewedApplication: next }
        : {},
    );
  },

  async viewShortlistBoard(companyId: string) {
    try {
      const res = await fetch(
        withImpersonate(
          `/api/companies/${companyId}/shortlist-board`,
          get().impersonateSessionId,
        ),
      );
      if (!res.ok) return;
      const data = (await res.json()) as ShortlistBoardView;
      set({
        viewedBoard: data,
        panelMode: "shortlist-board",
        panelMovedBy: "user",
        pendingBoardEditCount: data.pendingEdits,
      });
    } catch {
      // ignore
    }
  },

  // One discovery checkbox. Persists immediately and repaints from the server's
  // copy — it decides nothing until Hank's commit_discovery, so this is free to
  // fire on every click.
  async markSuggestion(suggestionId, mark) {
    if (get().impersonateSessionId) return;
    try {
      const res = await fetch("/api/discovery/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionId, mark }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as DiscoveryListView;
      set({
        viewedDiscovery: data,
        pendingDiscoveryMarkCount: data.pendingMarks,
      });
    } catch {
      // ignore
    }
  },

  async editShortlistBoard(companyId, jobId, verdict, reason) {
    if (get().impersonateSessionId) return;
    try {
      const res = await fetch(
        `/api/companies/${companyId}/shortlist-board/edit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId,
            verdict,
            ...(reason ? { reason } : {}),
          }),
        },
      );
      if (!res.ok) return;
      const data = (await res.json()) as ShortlistBoardView;
      // The count comes from the server rather than a local tally, so marking a
      // row and putting it back reads as zero changes — which is what it is.
      // It counts the VIEWED board; edits parked on another company's board
      // still relay, they just aren't in this number.
      set((s) => ({
        pendingBoardEditCount: data.pendingEdits,
        ...(s.viewedBoard?.companyId === companyId
          ? { viewedBoard: data }
          : {}),
      }));
    } catch {
      // ignore — the board re-derives from the server on the next refresh
    }
  },

  patchViewedJobInteraction(jobId, patch) {
    set((s) => {
      if (!s.viewedJob || s.viewedJob.id !== jobId) return {};
      return {
        viewedJob: {
          ...s.viewedJob,
          jobInteraction: { ...s.viewedJob.jobInteraction, ...patch },
        },
      };
    });
  },

  replaceViewedJob(jobId, next) {
    set((s) => (s.viewedJob?.id === jobId ? { viewedJob: next } : {}));
  },

  async newChat() {
    if (get().impersonateSessionId) return;
    try {
      const res = await fetch("/api/session/new", { method: "POST" });
      if (!res.ok) return;
      // Invalidate in-flight /api/session snapshots — one fetched before the
      // reset would resurrect the old session's messages when it lands.
      turnEpoch++;
      for (const ctrl of uploadAborts.values()) ctrl.abort();
      uploadAborts.clear();
      set({
        messages: [],
        // Any run being tracked belonged to the old session; the poll tick
        // sees the flag false and stops on its own.
        serverRunActive: false,
        viewedCompany: null,
        viewedJob: null,
        viewedOpportunity: null,
        viewedBoard: null,
        viewedApplication: null,
        pendingBoardEditCount: 0,
        panelMode: "dashboard",
        panelMovedBy: "user",
        documentsNav: { subPage: "index", expandedArtifacts: [] },
        activePanel: "chat",
        panelBadge: false,
        pendingAttachments: [],
      });
    } catch {
      // ignore — UI stays as-is
    }
  },

  async send(text: string) {
    // Admin view-session mode is read-only — refuse before any UI / fetch
    // side effects fire. The /api/chat server route also returns 403, but
    // catching it here keeps the chat history clean of error bubbles.
    if (get().impersonateSessionId) return;
    // A turn is already streaming — don't silently drop this send. Queue it and
    // flush when the current turn finishes (see the finally below). This is what
    // makes a widget-button click land mid-stream instead of no-op'ing. Last
    // write wins (one slot) — a rapid second message replaces the first queued.
    if (get().streaming) {
      set({ queuedSend: { text } });
      return;
    }
    const pending = get().pendingAttachments;
    // Still uploading? Refuse to send; the UI disables Send while uploads are
    // in flight, so this is defensive.
    if (pending.some((p) => p.status === "uploading")) return;
    const uploadedIds = pending
      .filter((p) => p.status === "uploaded" && p.attachmentId)
      .map((p) => p.attachmentId as string);
    const uploadedViews: AttachmentView[] = pending
      .filter((p) => p.status === "uploaded" && p.attachmentId)
      .map((p) => ({
        attachmentId: p.attachmentId as string,
        fileName: p.fileName,
        mediaKind: "", // unknown client-side; rehydrated on next refetch
      }));
    const trimmed = text.trim();
    // Pending board marks are content: sending with an empty composer is how
    // the user hands a batch of them over. The server derives the authoritative
    // list; these views just paint the bubble without waiting for the refetch.
    const board = get().viewedBoard;
    const pendingViews: PanelEditView[] =
      get().pendingBoardEditCount > 0 && board
        ? board.tiers
            .flatMap((t) => t.rows)
            .filter((r) => r.pending)
            .map((r) => ({
              title: r.title,
              companyName: board.companyName,
              verdict: r.verdict ?? "UNDECIDED",
            }))
        : [];
    // Same for an open application: unsent edits are content, so an empty
    // composer still sends. The server derives the authoritative list.
    const application = get().viewedApplication;
    if (application && application.pendingEditCount > 0) {
      pendingViews.push(
        ...application.items
          .filter((i) => i.edited || i.addedNotRelayed)
          .map((i) => ({
            title: i.label,
            companyName: application.companyName,
            verdict: i.edited ? "edited" : "added",
          })),
      );
    }
    if (!trimmed && uploadedIds.length === 0 && pendingViews.length === 0) {
      return;
    }

    const userId = crypto.randomUUID();
    // The bubble the turn opens in, before the server has named a row of its own.
    // A `message_start` moves the target from here onward (see applyEvent); this
    // one is left empty in that case and stops painting the moment the turn ends,
    // having served as the "…" placeholder while the first row was being built.
    const assistantId = crypto.randomUUID();
    let currentAssistantId = assistantId;
    const stopController = new AbortController();

    // A new turn begins: invalidate any /api/session snapshot still in flight
    // (see turnEpoch) so it can't clobber the optimistic pair below.
    turnEpoch++;

    set((s) => ({
      streaming: true,
      // A fresh send supersedes any prior "connection dropped" notice.
      streamInterrupted: false,
      stopController,
      // Clear any active pipeline widget — the user is sending a message
      // (which may or may not be a widget submission). Next pipeline event
      // can re-arm currentWidget.
      currentWidget: null,
      pendingAttachments: [],
      // Board edits made since the last message relay with THIS one (the
      // server snapshots them into the persisted user row at append time), so
      // the composer chip clears now. The persisted bubble shows them after
      // the end-of-turn refetch.
      pendingBoardEditCount: 0,
      messages: [
        ...s.messages,
        {
          id: userId,
          role: "user",
          segments: trimmed ? [{ kind: "text", text: trimmed }] : [],
          ...(uploadedViews.length > 0 ? { attachments: uploadedViews } : {}),
          ...(pendingViews.length > 0 ? { panelEdits: pendingViews } : {}),
        },
        { id: assistantId, role: "assistant", segments: [] },
      ],
    }));

    // Set when the stream ends abnormally (drop / background / transport
    // throw). Declared out here so the catch + finally can see it. The finally
    // reconciles from the DB — the turn's real progress is persisted
    // server-side regardless of what the live stream delivered.
    let abnormalEnd = false;
    // Set when the server refused this send because the previous run is still
    // draining (ALREADY_STREAMING). The finally hands the queued send to the
    // drain poll (see armRunActivePoll) instead of retrying on a timer — a
    // timed re-flush of a re-queued widget marker turns into a refuse→requeue→
    // resend loop against the still-draining run (which can hold the session
    // for minutes).
    let rejectedAlreadyStreaming = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          attachmentIds: uploadedIds.length > 0 ? uploadedIds : undefined,
          // Send the browser's IANA zone so Hank logs event times (interviews,
          // calls) at the right instant instead of midnight UTC. Guarded for
          // non-browser/SSR; the server falls back to UTC if absent.
          clientTimeZone:
            typeof Intl !== "undefined"
              ? Intl.DateTimeFormat().resolvedOptions().timeZone
              : undefined,
        }),
        signal: stopController.signal,
      });
      if (!res.ok || !res.body) {
        appendAssistantText(set, assistantId, `\n\n[error: ${res.status}]`);
        reportClientEvent({
          source: "chat_error",
          severity: "error",
          summary:
            "The user's message failed to start a reply — the server returned an error and they saw an error in the chat.",
          context: { code: String(res.status) },
        });
        return;
      }

      // Track whether the stream ended cleanly. A normal turn ends with a
      // `done` (or `stopped`/`error`) event; if the loop exits without one, the
      // SSE connection dropped mid-reply and the user saw the chat go silent.
      let sawTerminal = false;
      let lastToolName: string | undefined;
      for await (const ev of readSSE(res)) {
        // A `done`/`stopped`/`error` event is a clean terminal — including the
        // ALREADY_STREAMING refusal below. Track BEFORE that early `continue`
        // so a clean refusal isn't misread as a mid-stream disconnect.
        if (
          ev.type === "done" ||
          ev.type === "stopped" ||
          ev.type === "error"
        ) {
          sawTerminal = true;
        }
        if (ev.type === "tool_use_start") lastToolName = ev.name;
        // Server refused to start a second runUserMessage on the same
        // session because one is already in flight (see the ALREADY_STREAMING
        // guard in src/server/agent/runtime/runUserMessage.ts). Nothing was
        // persisted DB-side, so drop the optimistic user+assistant pair and
        // bounce the typed text back into the composer for the user to
        // resend after the current turn settles. Skip the apiKey-blocker /
        // `[error: …]` paths in applyEvent — neither matches this transient
        // case.
        if (ev.type === "error" && ev.code === "ALREADY_STREAMING") {
          // A concurrent run beat us to it. Nothing was persisted DB-side, so
          // drop the optimistic pair. For a WIDGET submission, the "text" is the
          // raw `<!--widget-response:…-->` marker — bouncing that into the
          // composer would paint the marker as if the user typed it. Re-queue it
          // instead so it fires once the in-flight turn ends (the widget stays
          // visible). For a typed message, restore the text to the composer.
          rejectedAlreadyStreaming = true;
          const isWidgetMarker = trimmed.startsWith("<!--widget-response:");
          set((s) => ({
            messages: s.messages.filter(
              (m) => m.id !== userId && m.id !== assistantId,
            ),
            ...(isWidgetMarker
              ? { queuedSend: { text } }
              : { restoreComposerText: trimmed }),
          }));
          continue;
        }
        currentAssistantId = applyEvent(set, currentAssistantId, ev);
      }
      if (!sawTerminal) {
        // SSE dropped before the terminal event — most often a backgrounded
        // tab / suspended PWA. Don't leave a silently-truncated bubble: mark
        // interrupted (soft "catching up…" notice) and let the finally pull
        // the real, persisted state.
        abnormalEnd = true;
        reportClientEvent({
          source: "sse_disconnect",
          summary: lastToolName
            ? "The connection dropped while I was still working on a task — my last update may not have reached the user."
            : "The chat connection dropped mid-reply — my last message may not have reached the user.",
          context: lastToolName ? { toolName: lastToolName } : undefined,
        });
      }
    } catch (err) {
      // Hard abort: server has already persisted the partial turn (with
      // stoppedByUser=true). Pull the canonical state instead of echoing
      // an [error: AbortError] string into the bubble.
      if (err instanceof DOMException && err.name === "AbortError") {
        try {
          await get().refetchSession();
        } catch {
          // refetchSession swallows its own errors; nothing else to do.
        }
        return;
      }
      // A thrown exception here is a TRANSPORT failure (fetch rejected / reader
      // threw because the connection died) — NOT an application error (those
      // arrive in-band as an SSE `error` event and are handled in applyEvent).
      // So treat it like a dropped connection: don't paint a scary `[error: …]`
      // bubble; mark interrupted and reconcile from the DB in the finally. The
      // turn's progress is persisted server-side regardless.
      abnormalEnd = true;
      reportClientEvent({
        source: "chat_error",
        severity: "error",
        summary:
          "The reply's connection failed partway through — recovering the turn's state from the server.",
        context: { code: "exception" },
      });
    } finally {
      set({
        streaming: false,
        stopController: null,
        // Surface the soft "connection dropped — catching up…" notice; the
        // reconcile below (and the return-to-app listeners) clear it once the
        // real state loads.
        ...(abnormalEnd ? { streamInterrupted: true } : {}),
      });
      // Now that streaming is false, pull the canonical state so a dropped /
      // backgrounded stream's real (persisted) progress replaces the partial
      // optimistic bubble — no manual refresh needed.
      if (abnormalEnd) get().reconcileFromServer();
      // Flush a send queued while this turn was streaming (e.g. a widget button
      // the user clicked mid-stream). streaming is now false, so this re-enters
      // send() normally. Done after the reconcile so the queued submission runs
      // against fresh state. If this turn was refused with ALREADY_STREAMING,
      // don't blind-retry on a timer (that loops refuse→requeue→resend for as
      // long as the run drains — minutes). Refetch instead: the response's
      // `runActive` arms the drain poll + "Hank is still working" notice, and
      // the poll's completion path flushes the queued send when the run ends.
      // If the run already finished by the time the refetch lands (runActive
      // false, poll never armed), flush here.
      if (rejectedAlreadyStreaming) {
        void get()
          .refetchSession()
          .then(() => {
            const st = get();
            if (st.queuedSend && !st.streaming && !st.serverRunActive) {
              const queued = st.queuedSend;
              set({ queuedSend: null });
              void st.send(queued.text);
            }
          });
      } else {
        const queued = get().queuedSend;
        if (queued) {
          set({ queuedSend: null });
          void get().send(queued.text);
        }
      }
    }
  },

  async stop() {
    const s = get();
    if (!s.streaming) return;
    reportClientEvent({
      source: "stop",
      severity: "info",
      summary: "The user clicked Stop to interrupt this reply.",
    });
    // One press = stop everything AND always hand control back to the user. The
    // stop endpoint aborts the run server-side; the runner then degrades to the
    // partial and streams a terminal stopped+done, which we keep reading to
    // render cleanly (no reconcile flash). But we must NOT depend on that
    // terminal arriving: a wedged run (a hung DB call, a loop that never checks
    // the abort signal) may never send it, and the 15s server keepalive keeps
    // the no-bytes watchdog from ever firing — the exact trap where the spinner
    // hung forever and Stop did nothing. Two guarantees close it:
    //   • If the endpoint can't help (no active run / non-OK), unstick now.
    //   • Otherwise arm a short grace timer; if we're still streaming after it,
    //     abort the local fetch so the send() catch → reconcile pulls the
    //     persisted state. This is an internal safety net, not a second press.
    const controllerAtStop = s.stopController;
    // Abort the fetch this Stop targeted — but only if that turn is still the
    // live one (a fast terminal, or a new turn the user started, must be spared).
    const recoverLocally = () => {
      const cur = get();
      if (cur.streaming && cur.stopController === controllerAtStop) {
        controllerAtStop?.abort();
      }
    };
    let serverAck = false;
    try {
      const res = await fetch("/api/chat/stop", { method: "POST" });
      const body = (await res.json().catch(() => null)) as {
        stopped?: boolean;
      } | null;
      serverAck = res.ok && body?.stopped === true;
    } catch {
      serverAck = false;
    }
    if (!serverAck) {
      // No run for the server to abort (already finished/cleared) or the POST
      // errored — the client is stuck on a stream that won't terminate. Recover
      // immediately; the run (if any) is done, so reconcile pulls full state.
      recoverLocally();
      return;
    }
    // Server is aborting the run. It normally streams the terminal within a
    // beat; if it doesn't (wedged run), force local recovery so the UI can never
    // be trapped in `streaming`.
    setTimeout(recoverLocally, STOP_TERMINAL_GRACE_MS);
  },
}));

function updateAssistantSegments(
  set: (fn: (s: State) => Partial<State>) => void,
  assistantId: string,
  fn: (segments: Segment[]) => Segment[],
) {
  set((s) => ({
    messages: s.messages.map((m) =>
      m.id === assistantId ? { ...m, segments: fn(m.segments) } : m,
    ),
  }));
}

// Append a text delta into the right segment list. When parentToolUseId is
// set the text routes into the matching tool's children (concatenating with
// the last text segment there if any); else into the top-level message.
function appendAssistantText(
  set: (fn: (s: State) => Partial<State>) => void,
  assistantId: string,
  delta: string,
  parentToolUseId?: string,
) {
  updateAssistantSegments(set, assistantId, (segments) =>
    parentToolUseId
      ? patchToolChildren(segments, parentToolUseId, (children) =>
          mergeTextDelta(children, delta),
        )
      : mergeTextDelta(segments, delta),
  );
}

// Append the "this run failed" segment to the streaming assistant message.
// Its own segment rather than `[error: …]` spliced into the assistant's prose:
// the raw detail is operator text (a Prisma code, a stack) that shouldn't read
// as something Hank said, and a segment is what the persisted `run_error` block
// reconciles back into. Idempotent on the same detail so a live paint followed
// by a reconcile can't stack two copies.
function appendAssistantError(
  set: (fn: (s: State) => Partial<State>) => void,
  assistantId: string,
  detail: string,
) {
  updateAssistantSegments(set, assistantId, (segments) =>
    segments.some((s) => s.kind === "error" && s.detail === detail)
      ? segments
      : [...segments, { kind: "error", detail }],
  );
}

// Append a UI-only status line (e.g. "Running shortlist over 15 jobs") to
// the streaming assistant message. Each event creates a separate segment so
// adjacent statuses stack visually rather than concatenating like text.
function appendAssistantStatus(
  set: (fn: (s: State) => Partial<State>) => void,
  assistantId: string,
  text: string,
) {
  updateAssistantSegments(set, assistantId, (segments) => [
    ...segments,
    { kind: "status", text },
  ]);
}

// Append a pipeline widget segment (shortlist_proposal etc.). One widget per
// segment; PipelineWidgetSlot reads the latest widget out of message history.
function appendAssistantWidget(
  set: (fn: (s: State) => Partial<State>) => void,
  assistantId: string,
  segment: WidgetSegment,
) {
  updateAssistantSegments(set, assistantId, (segments) => [
    ...segments,
    segment,
  ]);
}

// Walk segments to find a ToolSegment whose id matches parentToolUseId
// (recursively through children); replace its `children` with patcher's
// output. Returns the same array reference shape (immutable update where
// the parent path changes).
function patchToolChildren(
  segments: Segment[],
  parentToolUseId: string,
  patch: (children: Segment[]) => Segment[],
): Segment[] {
  let changed = false;
  const next = segments.map((seg) => {
    if (seg.kind !== "tool") return seg;
    if (seg.id === parentToolUseId) {
      changed = true;
      return {
        ...seg,
        children: patch(seg.children ?? []),
      };
    }
    if (!seg.children) return seg;
    const nestedNext = patchToolChildren(seg.children, parentToolUseId, patch);
    if (nestedNext !== seg.children) {
      changed = true;
      return { ...seg, children: nestedNext };
    }
    return seg;
  });
  return changed ? next : segments;
}

function mergeTextDelta(segments: Segment[], delta: string): Segment[] {
  const last = segments[segments.length - 1];
  if (last && last.kind === "text") {
    return [
      ...segments.slice(0, -1),
      { kind: "text", text: last.text + delta },
    ];
  }
  return [...segments, { kind: "text", text: delta }];
}

// Update a ToolSegment by id, walking children recursively. If
// parentToolUseId is set, scopes the lookup to descendants of that tool —
// keeps lookup unambiguous when the same toolUseId appears nowhere else but
// also makes nested routing explicit. When parentToolUseId is absent,
// matches the first occurrence found (top-level).
function mapAssistantTool(
  set: (fn: (s: State) => Partial<State>) => void,
  assistantId: string,
  toolId: string,
  fn: (t: ToolSegment) => ToolSegment,
  parentToolUseId?: string,
) {
  updateAssistantSegments(set, assistantId, (segments) =>
    parentToolUseId
      ? patchToolChildren(segments, parentToolUseId, (children) =>
          mapToolInTree(children, toolId, fn),
        )
      : mapToolInTree(segments, toolId, fn),
  );
}

function mapToolInTree(
  segments: Segment[],
  toolId: string,
  fn: (t: ToolSegment) => ToolSegment,
): Segment[] {
  let changed = false;
  const next = segments.map((seg) => {
    if (seg.kind !== "tool") return seg;
    if (seg.id === toolId) {
      changed = true;
      return fn(seg);
    }
    if (!seg.children) return seg;
    const nestedNext = mapToolInTree(seg.children, toolId, fn);
    if (nestedNext !== seg.children) {
      changed = true;
      return { ...seg, children: nestedNext };
    }
    return seg;
  });
  return changed ? next : segments;
}

// Upsert a ToolSegment by id. If a segment with this id already exists in
// the target scope, update its name/input (preserving status/result/children
// — those come from later events). Otherwise append. Upsert matters because
// the main loop emits tool_use_start twice for non-hidden tools: once mid-
// stream with `input: {}`, once post-stream with the real input.
function appendToolStart(
  set: (fn: (s: State) => Partial<State>) => void,
  assistantId: string,
  segment: ToolSegment,
  parentToolUseId?: string,
) {
  updateAssistantSegments(set, assistantId, (segments) =>
    parentToolUseId
      ? patchToolChildren(segments, parentToolUseId, (children) =>
          upsertToolSegment(children, segment),
        )
      : upsertToolSegment(segments, segment),
  );
}

function upsertToolSegment(segments: Segment[], next: ToolSegment): Segment[] {
  const idx = segments.findIndex((s) => s.kind === "tool" && s.id === next.id);
  if (idx < 0) return [...segments, next];
  const existing = segments[idx] as ToolSegment;
  const merged: ToolSegment = {
    ...existing,
    name: next.name,
    input: next.input,
  };
  return [...segments.slice(0, idx), merged, ...segments.slice(idx + 1)];
}

type LoopEventJson =
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
      // Server signal that completion of this tool may have changed entities
      // the user is currently looking at. Triggers a debounced mid-turn
      // refetch of the dashboard + viewed entity payloads.
      affectsViewedState?: boolean;
    }
  | {
      type: "ui";
      event:
        | {
            // Presentational "put this entity on screen" event (show_* tools +
            // pipeline dispatch) — updates only viewed*/panelMode. Focus is
            // ephemeral; there's no sticky focus slot to touch.
            type: "show";
            company: ServerFocusedCompanyView | null;
            job: ServerFocusedJobView | null;
            opportunity: ServerFocusedOpportunityView | null;
            board: ShortlistBoardView | null;
            application: ApplicationView | null;
            discovery: DiscoveryListView | null;
          }
        | { type: "panel_mode"; mode: PanelMode };
    }
  | {
      type: "widget";
      toolUseId: string;
      kind: WidgetKind;
      payload: unknown;
    }
  | { type: "pipeline_status"; text: string }
  | {
      type: "pipeline_widget";
      toolUseId: string;
      kind: string;
      payload: unknown;
    }
  // The server opened a new assistant ChatMessage row; everything after it
  // belongs in a bubble under that id. See applyEvent's message_start case.
  | { type: "message_start"; messageId: string }
  // Transient mid-turn refresh ping from a deterministic pipeline runner —
  // schedules the same debounced dashboard + viewed-entity refetch that an
  // affectsViewedState tool completion does. No payload, nothing to render.
  | { type: "refresh_viewed_state" }
  | { type: "stopped" }
  | { type: "done" }
  | { type: "error"; message: string; code?: string };

// Debounced mid-turn refresh of dashboard + currently-viewed entity payloads.
// Called when a `tool_use_complete` arrives with `affectsViewedState: true`.
// Coalesces rapid sequential triggers (e.g. a flurry of status updates
// calls) into a single /api/dashboard hit. Cleared on the `done` handler so
// the end-of-turn refresh isn't double-fired on top of a pending debounce.
const VIEWED_STATE_DEBOUNCE_MS = 300;
let viewedStateRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleViewedStateRefresh() {
  if (viewedStateRefreshTimer !== null) clearTimeout(viewedStateRefreshTimer);
  viewedStateRefreshTimer = setTimeout(() => {
    viewedStateRefreshTimer = null;
    const s = useChatStore.getState();
    void s.refetchDashboard();
    void s.refreshViewedEntities();
  }, VIEWED_STATE_DEBOUNCE_MS);
}
function cancelPendingViewedStateRefresh() {
  if (viewedStateRefreshTimer !== null) {
    clearTimeout(viewedStateRefreshTimer);
    viewedStateRefreshTimer = null;
  }
}

// Apply one streamed event to `assistantId`'s bubble, and return the bubble the
// NEXT event belongs to — normally the same one, but a `message_start` moves it.
//
// A run writes several assistant ChatMessage rows (each narrated line is its own
// row, as is each Hank turn), so painting the whole run into one bubble meant the
// end-of-turn reconcile — which loads those rows — visibly re-cut the
// conversation the moment it finished. The server names each row's id as it opens
// it; following that here is what makes the reconcile a no-op.
function applyEvent(
  set: (fn: (s: State) => Partial<State>) => void,
  assistantId: string,
  ev: LoopEventJson,
): string {
  switch (ev.type) {
    case "message_start":
      // First event of a new row. Open an empty bubble under the server's id so
      // the segments below land in it and the reconcile recognises it. Nothing
      // renders yet: an empty assistant bubble only paints while it's the last
      // one and the turn is still streaming (the "…" placeholder).
      set((s) =>
        s.messages.some((m) => m.id === ev.messageId)
          ? {}
          : {
              messages: [
                ...s.messages,
                { id: ev.messageId, role: "assistant", segments: [] },
              ],
            },
      );
      return ev.messageId;
    case "text":
      appendAssistantText(set, assistantId, ev.text, ev.parentToolUseId);
      break;
    case "tool_use_start":
      appendToolStart(
        set,
        assistantId,
        {
          kind: "tool",
          id: ev.toolUseId,
          name: ev.name,
          input: ev.input,
          status: "pending",
        },
        ev.parentToolUseId,
      );
      break;
    case "tool_use_progress":
      mapAssistantTool(
        set,
        assistantId,
        ev.toolUseId,
        (t) => ({ ...t, progressLabel: ev.label }),
        ev.parentToolUseId,
      );
      break;
    case "tool_use_complete":
      mapAssistantTool(
        set,
        assistantId,
        ev.toolUseId,
        (t) => ({
          ...t,
          status: ev.error ? "error" : "done",
          result: ev.result,
          progressLabel: undefined,
        }),
        ev.parentToolUseId,
      );
      // Schedule a debounced mid-turn refresh of the dashboard + currently-
      // viewed entity payloads when the server flags the tool as having
      // changed user-visible state. The flag is set by runAgentTurn
      // (src/server/agent/runtime/runAgentTurn.ts) from each tool's
      // `affectsViewedState` metadata; sub-agent tools also propagate it
      // through the trace bridge, so we don't gate on parentToolUseId.
      if (ev.affectsViewedState) {
        scheduleViewedStateRefresh();
      }
      break;
    case "widget":
      // Sticky-bar widget. Replaces the latest currentWidget; the dispatcher
      // in components/Chat/widgets/ renders by `kind`. Only one widget active
      // at a time; cleared on user send(). This is the *transient* path —
      // streams the widget live for the next_company_picker flow so the user
      // doesn't have to wait for a history refetch. The persisted
      // pipeline_widget block (below) handles refresh durability.
      set(() => ({
        currentWidget: {
          toolUseId: ev.toolUseId,
          kind: ev.kind,
          payload: ev.payload,
        },
      }));
      break;
    case "pipeline_status":
      // Append a status segment to the current assistant message. Distinct
      // from regular text — rendered as a chip/divider here. On replay the
      // server renders the matching pipeline_status block to plain text for
      // the LLM (loadSessionMessages), so Hank remembers the narration.
      appendAssistantStatus(set, assistantId, ev.text);
      break;
    case "pipeline_widget":
      // Append a widget segment to the current assistant message. The
      // PipelineWidgetSlot reads the latest widget segment from message
      // history; on refresh, the segment re-loads from the persisted
      // pipeline_widget content block. Triggers the same viewed-state
      // refresh as a state-mutating tool.
      appendAssistantWidget(set, assistantId, {
        kind: "widget",
        toolUseId: ev.toolUseId,
        widgetKind: ev.kind,
        payload: ev.payload,
      });
      scheduleViewedStateRefresh();
      break;
    case "refresh_viewed_state":
      // A deterministic pipeline step just wrote user-visible state mid-run
      // (e.g. persisted a drafted cover letter, enriched the next company in a
      // batch). Refetch the dashboard + viewed entity now instead of waiting
      // for the end-of-turn `done`. Debounced, so a loop emitting one per item
      // collapses into a single refetch.
      scheduleViewedStateRefresh();
      break;
    case "ui": {
      const inner = ev.event;
      if (inner.type === "show") {
        // Presentational panel switch from a show_* tool (or pipeline dispatch):
        // sync viewed* so the panel follows the entity Hank surfaced. Focus is
        // ephemeral — showing an entity is a view change, nothing sticky.
        set((s) => ({
          viewedCompany: inner.company,
          viewedJob: inner.job,
          viewedOpportunity: inner.opportunity,
          viewedBoard: inner.board ?? null,
          viewedApplication: inner.application ?? null,
          viewedDiscovery: inner.discovery ?? null,
          pendingDiscoveryMarkCount: inner.discovery?.pendingMarks ?? 0,
          // Mid-turn change while the user is on the chat tab → badge the
          // right tab so they know there's something to look at. The end-of-
          // turn `done` handler decides whether to auto-flip.
          panelBadge: s.activePanel === "chat" ? true : s.panelBadge,
          // Hank moving the panel isn't the user navigating, so the URL is
          // rewritten rather than pushed — Back walks the user's own trail.
          panelMovedBy: "agent" as const,
        }));
      } else if (inner.type === "panel_mode") {
        set((s) => ({
          panelMode: inner.mode,
          panelMovedBy: "agent" as const,
          panelBadge: s.activePanel === "chat" ? true : s.panelBadge,
          // Wide viewport: a collapsed right panel hides whatever Hank just
          // surfaced. Expand on agent-driven panel changes so the user sees
          // the new mode. The user's own collapse-toggle re-collapses freely.
          rightCollapsed: false,
        }));
      }
      break;
    }
    case "error":
      if (
        ev.code === "NO_ANTHROPIC_KEY" ||
        ev.code === "NO_DEEPSEEK_KEY" ||
        ev.code === "INVALID_ANTHROPIC_KEY" ||
        ev.code === "ANTHROPIC_NO_CREDIT" ||
        ev.code === "INVALID_DEEPSEEK_KEY" ||
        ev.code === "DEEPSEEK_NO_CREDIT"
      ) {
        const reason: ApiKeyBlockerReason =
          ev.code === "NO_ANTHROPIC_KEY"
            ? "missing"
            : ev.code === "NO_DEEPSEEK_KEY"
              ? "missing_deepseek"
              : ev.code === "INVALID_ANTHROPIC_KEY"
                ? "invalid"
                : ev.code === "ANTHROPIC_NO_CREDIT"
                  ? "no_credit"
                  : ev.code === "INVALID_DEEPSEEK_KEY"
                    ? "invalid_deepseek"
                    : "deepseek_no_credit";
        // Drop the empty pre-created assistant shell so the chat doesn't show
        // an orphan blank bubble after the user fixes the key. Partial turns
        // (when some text already streamed before the error) stay intact.
        set((s) => ({
          apiKeyBlocker: reason,
          messages: s.messages.filter(
            (m) =>
              !(
                m.id === assistantId &&
                m.role === "assistant" &&
                m.segments.length === 0
              ),
          ),
        }));
        reportClientEvent({
          source: "modal",
          summary:
            "The user hit a blocker about their API key or account credit and had to resolve it before this message could go through.",
          context: { reason },
        });
      } else {
        appendAssistantError(set, assistantId, ev.message);
        reportClientEvent({
          source: "chat_error",
          severity: "error",
          summary:
            "An error interrupted the reply — the user saw an error notice in the chat instead of a normal response.",
          context: {
            code: ev.code ?? "stream_error",
            errorMessage: ev.message,
          },
        });
      }
      break;
    case "stopped":
      // Mark the live assistant message as stopped so the "Stopped by user"
      // pill renders immediately. refetchSession on done/AbortError pulls the
      // canonical row state — this is the optimistic update for the soft-stop
      // path where the SSE keeps streaming (we don't auto-abort the fetch).
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, stoppedByUser: true } : m,
        ),
      }));
      break;
    case "done":
      // End of agent turn. If the right panel changed during this turn and
      // the user stayed on the chat tab the whole time, flip them over so
      // they see the result. Mid-turn we only badged; here we commit.
      set((s) =>
        s.panelBadge && s.activePanel === "chat"
          ? { activePanel: "right", panelBadge: false }
          : {},
      );
      // JobInteractions / events may have changed — refresh dashboard + focused
      // entity state. refetchSession only touches viewed* if it currently
      // matches focus, so the user's chosen view is preserved.
      // refreshViewedEntities catches the other case: user is browsing a
      // company/job that *isn't* the agent's focus (e.g. user is on Perplexity
      // while the agent just updated something at Dust, or vice versa), so
      // the panel still reflects the latest DB state. Cancel any pending
      // debounce so we don't double-fire on top of this end-of-turn refresh.
      cancelPendingViewedStateRefresh();
      void useChatStore.getState().refetchDashboard();
      void useChatStore.getState().refetchSession();
      void useChatStore.getState().refreshViewedEntities();
      break;
  }
  return assistantId;
}

// Watchdog on the SSE reader. The server writes a `: keepalive` comment every
// 15s even during long silent phases, so a healthy connection always delivers
// bytes well inside this window. When nothing arrives, the socket died without
// the client noticing (half-open TCP after a network flip / OS-suspended tab)
// and reader.read() would hang forever — leaving `streaming: true`, the
// composer locked, and every reconcile skipped by its streaming guard until a
// manual refresh. Bail out instead: the caller's `sawTerminal` check then
// treats it as a dropped stream and reconciles from the DB.
const SSE_READ_TIMEOUT_MS = 45_000;

// After Stop, how long to wait for the server's terminal stopped+done before
// forcing local recovery (abort the fetch → reconcile). Long enough for the
// normal abort→persist→emit path (~1s) so a healthy Stop still renders the clean
// terminal without a reconcile flash; short enough that a wedged run doesn't
// trap the UI. See chatStore.stop().
const STOP_TERMINAL_GRACE_MS = 5_000;

async function* readSSE(response: Response): AsyncGenerator<LoopEventJson> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = reader.read();
    // eslint-disable-next-line no-await-in-loop -- reading the next SSE chunk — there is no next chunk until this one arrives
    const result = await Promise.race([
      read,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), SSE_READ_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result === "timeout") {
      // Silence the raced-out read so a late rejection isn't unhandled, and
      // release the connection. cancel() is fire-and-forget — on a dead
      // socket it may itself never settle.
      read.catch(() => {});
      void reader.cancel().catch(() => {});
      return;
    }
    const { done, value } = result;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data) continue;
      try {
        yield JSON.parse(data) as LoopEventJson;
      } catch {
        // ignore malformed lines
      }
    }
  }
}
