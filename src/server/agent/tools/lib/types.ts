import type {
  UiEvent,
  EntryTarget,
  RunContext,
} from "@/server/agent/contracts";

import type { ToolError } from "./toolError";
import type { z } from "zod";
// Cross-layer vocabularies that non-tool producers emit too — see their homes
// for why they don't live here.

// Detail-page payload types live with their loaders in views/ — a view owns the
// shape it returns. Re-exported here so the client chat store, the right-panel
// views, and the api routes keep importing them from this barrel, and so the
// `UiEvent` contract (agent/contracts/uiEvent.ts, which composes all three
// focused views) resolves them in one place.
export type {
  CompanyJobView,
  FocusedCompanyView,
} from "@/server/views/getFocusedCompany";
export type { FocusedJobView } from "@/server/views/getFocusedJob";
export type { ShortAnswer } from "@/server/entities/jobs/types";
export type {
  OpportunityJobView,
  FocusedOpportunityView,
} from "@/server/views/getFocusedOpportunity";
export type { ContactView } from "@/server/views/contactView";

export type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
} from "@/server/scrape/types";

// A tool handler's context IS the ambient RunContext — a tool dispatch is just
// one more place deterministic work runs for a user. `runAgentTurn` assembles it
// once per dispatch, setting `trace.parentToolUseId` to this tool's own
// tool_use_id so anything it spawns nests under its chip. A handler forwards it
// verbatim (`{ ...ctx, companyId }`) into whatever procedure it enters; there is
// nothing to convert.
//
// `sessionId` is required here and optional on RunContext: a tool only ever runs
// inside a chat dispatch.
export type ToolContext = RunContext & {
  sessionId: string;
};

// Pipeline widgets a tool wants to emit on top of its content. The runner
// yields each as a `pipeline_widget` event for live display; the tool handler
// is responsible for persisting the widget block (via appendAssistantMessage)
// so it survives a refresh. Used by display_shortlist to re-emit a dismissed
// proposal without re-running the shortlist sub-agent.
export type ToolEmittedWidget = {
  kind: string;
  toolUseId: string;
  payload: unknown;
};

export type ToolResult = {
  content: string;
  events?: UiEvent[];
  widgets?: ToolEmittedWidget[];
  // Deterministic status lines this tool wants to drop into the chat transcript
  // (persisted as `pipeline_status` blocks, stripped from the LLM's replay). Used
  // by the show_* tools to emit a "Pulled up <focus-ref…/>" chip line. The runner
  // persists these on a follow-up assistant message (like `widgets`).
  statusLines?: string[];
  // What this handoff tool handed over — work_on_job → the job,
  // company_walkthrough → the company, scrape_jobs_for_company → the company,
  // find_companies → discovery. The runner threads it to the state machine,
  // which runs that entity's arm. Undefined for every tool that isn't a handoff.
  entryTarget?: EntryTarget;
  // This tool ENDED a company (close / pause / block / caught-up). The runner
  // reads it twice: to run the segment wrap once for the message (see
  // procedures/registry/wrapCompanySegment.ts) and to report a wrap so
  // runUserMessage brings up what's-next. It rides the RESULT rather than the
  // static `handoff` flag because whether a company ended is an outcome, not a
  // property of the tool: caught_up_company bails to a confirmation prompt when
  // open roles remain, and ends nothing. (Same reason commit_profile isn't a
  // handoff tool.) A mutation must NOT be `handoff` — that would end Hank's
  // turn mid-sentence and cap "pause these six" at one.
  endedCompanyId?: string;
  // Structured error — its PRESENCE means failure. Build via
  // `toolError(code, message, dedupHint?)` from ./toolError, which also bakes
  // the `<!--tool-error:{...}-->` audit marker into `content`.
  error?: ToolError;
};

export interface ToolDef<TInput> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parser: z.ZodType<TInput>;
  handle: (input: TInput, ctx: ToolContext) => Promise<ToolResult>;
  // Whether completing this tool may have changed entities the user is
  // currently looking at (dashboard buckets, focused company/job/opportunity).
  // When it does, the chat client schedules a debounced mid-turn refetch of the
  // dashboard + viewed entity payloads.
  //
  // Default is opt-OUT: leaving this unset counts as `true`, so a mutation tool
  // that forgets the flag still refreshes (a redundant refetch is cheap; stale
  // data on screen is not). Set it explicitly to `false` only for pure reads and
  // for writes that don't surface on user-visible surfaces (memory notes,
  // AdminNote, observation channels) to skip the pointless refetch. See
  // `toolAffectsViewedState` in ./index.
  affectsViewedState?: boolean;
  // When true, this tool hands control off to the deterministic layer (it moves
  // the dispatch target — the entity the state machine runs its arm on). Once it
  // fires, the agent has nothing more to do this user-message — the deterministic
  // layer owns the next on-screen surface (shortlist / next-job picker).
  // procedures/registry/chat/runChatTurn.ts STOPS its agent loop after a handoff
  // turn instead of running another agent turn: that extra
  // turn has no legitimate work and is where the agent confabulated a fake
  // on-screen role list (imitating the provenance notes it sees in replayed
  // history, inventing roles the runner hadn't surfaced yet). Set this
  // on any new routing tool so the loop-stop is automatic — don't re-introduce
  // a hardcoded name list.
  handoff?: boolean;
}

export type AnyToolDef = ToolDef<unknown>;
