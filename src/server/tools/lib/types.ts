// Hank's tool contract: the platform agent loop's contract (platform/agentLoop/
// tool.ts) resolved to this product. The loop relays `events` and persists
// `statusLines` without reading them; the two outcome fields below it hands back
// untouched in `dispatched`, and procedures/registry/chat/runChatTurn.ts is what
// reads them.

import type { EntryTarget, UiEvent } from "@/server/contracts";
import type {
  ToolDef as LoopToolDef,
  ToolResult as LoopToolResult,
} from "@/server/platform/agentLoop/tool";

export type { ToolContext } from "@/server/platform/agentLoop/tool";

export type ToolResult = LoopToolResult<UiEvent> & {
  // What this handoff tool handed over — work_on_job → the job,
  // company_walkthrough → the company, scrape_jobs_for_company → the company,
  // find_companies → discovery. The chat turn threads it to the state machine,
  // which runs that entity's arm. Undefined for every tool that isn't a handoff.
  entryTarget?: EntryTarget;
  // This tool ENDED a company (close / pause / block / caught-up). The chat turn
  // reads it twice: to run the segment wrap once for the message (see
  // procedures/registry/wrapSegment.ts) and to bring up what's next. It rides
  // the RESULT rather than the static `handoff` flag because whether a company
  // ended is an outcome, not a property of the tool: caught_up_company bails to
  // a confirmation prompt when open roles remain, and ends nothing. A mutation
  // must NOT be `handoff` — that would end Hank's turn mid-sentence and cap
  // "pause these six" at one.
  endedCompanyId?: string;
};

export type ToolDef<TInput> = LoopToolDef<TInput, ToolResult>;

export type AnyToolDef = ToolDef<unknown>;
