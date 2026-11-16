// Hank's tool types: the agent loop's generic contract (platform/agent/tool.ts)
// narrowed to this product — its panel events, its widget kinds, and the two
// outcome fields the chat procedure folds after a turn
// (procedures/registry/chat/runChatTurn.ts). The loop carries these fields
// without reading them.

import type { EntryTarget } from "@/server/contracts";
import type {
  AgentToolDef,
  AgentToolResult,
} from "@/server/platform/agent/tool";
import type { UiEvent } from "@/shared/chatStream";
import type { WidgetKind } from "@/shared/widgetKinds";

export type ToolResult = AgentToolResult<UiEvent, WidgetKind> & {
  // What this handoff tool handed over — work_on_job → the job,
  // company_walkthrough → the company, scrape_jobs_for_company → the company,
  // find_companies → discovery. The runner threads it to the state machine,
  // which runs that entity's arm. Undefined for every tool that isn't a handoff.
  entryTarget?: EntryTarget;
  // This tool ENDED a company (close / pause / block / caught-up). The runner
  // reads it twice: to run the segment wrap once for the message (see
  // procedures/registry/wrapSegment.ts) and to report a wrap so
  // runUserMessage brings up what's-next. It rides the RESULT rather than the
  // static `handoff` flag because whether a company ended is an outcome, not a
  // property of the tool: caught_up_company bails to a confirmation prompt when
  // open roles remain, and ends nothing. (Same reason commit_profile isn't a
  // handoff tool.) A mutation must NOT be `handoff` — that would end Hank's
  // turn mid-sentence and cap "pause these six" at one.
  endedCompanyId?: string;
};

export type ToolDef<TInput> = AgentToolDef<TInput, ToolResult>;

export type AnyToolDef = ToolDef<unknown>;
