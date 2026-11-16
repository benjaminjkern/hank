// Hank's tool types: the agent loop's generic contract (platform/agent/tool.ts)
// narrowed to this product — the panel events a tool shows, the Entry a handoff
// tool queues, and the one outcome field the chat procedure reads after a turn
// (procedures/registry/chat/hankTurns.ts). The loop carries these without
// reading them.
//
// A tool is dumb on purpose: it does its one thing and reports back. It shows
// things through `ctx.say` (a panel move, a status line — never a widget; asking
// the user is a procedure's job), and a handoff tool hands Hank's request to a
// procedure through `ctx.queue`. What runs after that is the procedure's call.

import type { Entry, Segment } from "@/server/contracts";
import type {
  AgentToolDef,
  AgentToolResult,
  ToolContext as AgentToolContext,
} from "@/server/platform/agent/tool";
import type { UiEvent } from "@/shared/chatStream";

export type ToolContext = AgentToolContext<UiEvent, Entry>;

export type ToolResult = AgentToolResult & {
  // A stretch of work this tool's write ended — a company closed / paused /
  // blocked / caught up. A FACT, not routing: it moves nothing on its own. The
  // chat loop reads it after the message to file the stretch away once
  // (procedures/registry/wrapSegment.ts), however many tools reported one.
  // It rides the result rather than a static flag because whether something
  // ended is an outcome: caught_up_company bails to a confirmation when open
  // roles remain, and ends nothing.
  ended?: Segment;
};

export type ToolDef<TInput> = AgentToolDef<TInput, ToolResult, UiEvent, Entry>;
export type AnyToolDef = ToolDef<unknown>;
