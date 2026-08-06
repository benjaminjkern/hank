// One Hank turn, end to end: resolve the key, load the transcript, stream the
// completion + dispatch its tools (runAgentTurn), persist everything that came
// back, meter it.
//
// It knows WHO the agent is (agent/hank/ — the model, the tool list, the handoff
// rule) and nothing about what he's talking about. The caller supplies the
// prompt as a BUILDER rather than a string, because what belongs in it can
// depend on the loaded transcript: this hands back the transcript fact
// (hasPriorAssistantTurn) and the caller decides what it means. Deciding whether
// this turn runs the profile-intake body, which companies are switchable, or
// what gaps to open on is domain work and lives with the domain
// (procedures/registry/chat/runChatTurn.ts). Same for the outcome — this returns
// each tool's raw result and lets the caller decide one of them ended a company.

import type { RunContext, StreamEvent } from "@/server/agent/contracts";
import {
  HANK_MAX_TOKENS,
  HANK_MODEL,
  HANK_REASONING,
  hankTools,
  turnCalledHandoffTool,
  type HankSystemPrompt,
} from "@/server/agent/hank";
import {
  runAgentTurn,
  type DispatchedTool,
} from "@/server/agent/runtime/runAgentTurn";
import { applyHistoryCacheMarker } from "@/server/agent/runtime/streamingCore";
import { captureTurn } from "@/server/agent/runTree/captureTurn";
import {
  appendAssistantMessage,
  appendToolResultMessage,
  loadSessionMessages,
} from "@/server/agent/session";
import { resolveLlmClient } from "@/server/platform/llm/resolveClient";
import { recordUsage } from "@/server/platform/usage/track";

import type Anthropic from "@anthropic-ai/sdk";

// What this turn's transcript looks like, handed to the prompt builder. It's a
// transcript fact, not a product one — what to DO with it (Hank's "continuing"
// banner) is the caller's call.
export type TranscriptInfo = {
  // The loaded history already contains at least one assistant turn, i.e. this
  // isn't the first thing said in the session.
  hasPriorAssistantTurn: boolean;
};

export type HankTurnArgs = RunContext & {
  sessionId: string;
  // Called once the transcript is loaded, since what belongs in the prompt can
  // depend on it. Returns the whole HankSystemPrompt (not just `.full`) because
  // captureTurn stores its static hash + volatile sections.
  buildSystem: (
    info: TranscriptInfo,
  ) => HankSystemPrompt | Promise<HankSystemPrompt>;
  // Which agent turn this is within the message, for the persisted rows.
  turnIndex: number;
  // A synthetic user turn to append when the loaded history doesn't already end
  // with one. Set it ONLY when the turn is supposed to open the conversation
  // rather than answer something: the API rejects a message list that's empty or
  // ends on an assistant turn ("the conversation must end with a user message"),
  // and a cold start is exactly that. Never persisted, so it never shows up in
  // chat history. Supplying it also bypasses the endsAwaitingUser bail below —
  // there IS nothing for the user to have answered, which is the point.
  openingNudge?: string;
};

export type HankTurnResult = {
  agentCalledTool: boolean;
  // The agent handed control to the deterministic layer this turn, so the loop
  // stops here. A `handoff` is a ToolDef flag, not a name list — see
  // agent/hank/toolset.ts.
  calledHandoffTool: boolean;
  // Every tool this turn ran, in order, with its raw result. The caller reads
  // whatever domain signals it cares about off these.
  dispatched: DispatchedTool[];
};

export async function* runHankTurn(
  args: HankTurnArgs,
): AsyncGenerator<StreamEvent, HankTurnResult> {
  const { client, model, billedToServer } = await resolveLlmClient(
    args.userId,
    {
      model: HANK_MODEL,
    },
  );
  const loaded = await loadSessionMessages(args.sessionId);

  // A prior loop iteration that emitted a widget or a status line leaves the
  // reloaded history ending on a completed assistant/UI turn with nothing new to
  // respond to. That's a wait-for-user terminal (and re-invoking on a trailing
  // assistant is an invalid prefill — DeepSeek v4-pro 400s it, as does
  // claude-sonnet-4-6 under the provider override), so there's nothing more to
  // do this turn: stop instead of making the doomed call. loadSessionMessages
  // computes this from the RAW rows, because provenance re-roling can move the
  // terminal off the assistant channel — see endsAwaitingUser.
  if (loaded.endsAwaitingUser && !args.openingNudge) {
    return { agentCalledTool: false, calledHandoffTool: false, dispatched: [] };
  }
  const history = applyHistoryCacheMarker(
    args.openingNudge
      ? ensureEndsWithUser(loaded.messages, args.openingNudge)
      : loaded.messages,
  );
  const system = await args.buildSystem({
    hasPriorAssistantTurn: history.some((m) => m.role === "assistant"),
  });

  const turn = yield* runAgentTurn({
    ...args,
    client,
    model,
    maxTokens: HANK_MAX_TOKENS,
    reasoning: HANK_REASONING,
    system: system.full,
    tools: hankTools(),
    history,
  });

  await appendAssistantMessage(args.sessionId, turn.content, {
    id: turn.messageId,
    runId: args.runId,
    turnIndex: args.turnIndex,
    traces: turn.traces,
    ...(turn.stopped || turn.errored != null ? { stoppedByUser: true } : {}),
  });
  if (turn.toolResults.length > 0) {
    await appendToolResultMessage(args.sessionId, turn.toolResults, {
      runId: args.runId,
      turnIndex: args.turnIndex,
    });
  }
  // These two rows carry the ids runAgentTurn already announced on the stream —
  // pass them through, or the client's live bubbles and these rows are different
  // messages and the turn re-shuffles on screen when the reconcile lands.
  if (turn.emittedWidgets.length > 0) {
    await appendAssistantMessage(
      args.sessionId,
      turn.emittedWidgets.map(
        (w) =>
          ({
            type: "pipeline_widget",
            toolUseId: w.toolUseId,
            kind: w.kind,
            payload: w.payload,
          }) as unknown as Anthropic.ContentBlock,
      ),
      {
        id: turn.widgetsMessageId,
        runId: args.runId,
        turnIndex: args.turnIndex,
      },
    );
  }
  if (turn.emittedStatusLines.length > 0) {
    await appendAssistantMessage(
      args.sessionId,
      turn.emittedStatusLines.map(
        (text) =>
          ({
            type: "pipeline_status",
            text,
          }) as unknown as Anthropic.ContentBlock,
      ),
      {
        id: turn.statusLinesMessageId,
        runId: args.runId,
        turnIndex: args.turnIndex,
      },
    );
  }

  await recordUsage({
    userId: args.userId,
    operation: "chat",
    model,
    billedToServer,
    usage: turn.usage,
    sessionId: args.sessionId,
    notes:
      turn.errored != null
        ? `pipeline=chat interrupted_error`
        : turn.stopped
          ? `pipeline=chat stopped_by_user`
          : `pipeline=chat stop_reason=${turn.stopReason ?? "?"}`,
    runId: args.runId,
    messageId: turn.messageId,
    ...(await captureTurn("chat", system, turn)),
  });

  if (turn.stopped) yield { type: "stopped" };

  // Genuine mid-stream fault: the partial is saved above (resumable); re-throw
  // so the error still surfaces (key modal / error bubble) up through the chat
  // route. `errored` is a caught value (`unknown`); the explicit local re-widens
  // it after `!= null` narrowing so it's re-thrown as-is, not coerced.
  if (turn.errored != null) {
    const fault: unknown = turn.errored;
    throw fault;
  }

  return {
    agentCalledTool: turn.content.some((b) => b.type === "tool_use"),
    calledHandoffTool: !turn.stopped && turnCalledHandoffTool(turn.content),
    dispatched: turn.dispatched,
  };
}

// Append a synthetic, NON-persisted user turn so the agent has something to
// answer. Parenthesized by convention at the call site so the model reads it as
// a system nudge rather than literal user words to echo.
function ensureEndsWithUser(
  history: Anthropic.MessageParam[],
  nudge: string,
): Anthropic.MessageParam[] {
  const last = history[history.length - 1];
  if (last && last.role === "user") return history;
  return [...history, { role: "user", content: nudge }];
}
