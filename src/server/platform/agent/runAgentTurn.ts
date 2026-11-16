// Single-turn agent helper — runHankTurn calls this for every turn that needs an
// LLM response.
//
// Tool dispatch goes through `args.tools` (the list the caller passed, and the
// one the model was advertised) rather than a global registry, so the advertised
// set and the dispatchable set can't drift.
//
// What this helper does:
//   - Streams a completion. Yields text deltas + tool_use_start.
//   - Dispatches each tool_use sequentially against that list.
//   - Yields tool_use_progress / tool_use_complete / ui events.
//   - Returns the final assistant content, the tool results, and each tool's
//     RAW outcome, so the caller can persist, build the next-turn history, and
//     read whatever domain signals its tools set.
//
// What this helper does NOT do:
//   - Session message persistence (runHankTurn handles it).
//   - INTERPRET a tool outcome. It dispatches whatever it was handed and hands
//     back what came out, in order; deciding that one of them named a company or
//     a handoff target belongs to the domain layer that owns those meanings
//     (procedures/registry/chat/). That's why `dispatched` is a raw list and not
//     a pair of folded, already-interpreted fields.
//   - Sub-agent trace fanout (sub-agents called by tool handlers emit their
//     own traces via ctx.trace; this helper forwards them as-is).

import {
  HIDDEN_TOOLS,
  isTransientStreamError,
  emptyAbortedMessage,
} from "@/server/platform/agent/streamingCore";
import type {
  AgentToolDef,
  AgentToolResult,
  AgentToolWidget,
  ToolContext,
} from "@/server/platform/agent/tool";
import { toolErrorContent } from "@/server/platform/agent/toolError";
import { toolInputSchema } from "@/server/platform/agent/toolInputSchema";
import type { Reasoning } from "@/server/platform/llm/reasoning";
import type { RunContext } from "@/server/platform/runContext";
import { withCaptureContext } from "@/server/platform/runs/captureContext";
import { newRunTreeId } from "@/server/platform/runs/ids";
import type { TraceEvent } from "@/server/platform/runs/trace";
import {
  createTraceAccumulator,
  type TraceMap,
} from "@/server/platform/runs/traceAccumulator";
import type { StreamEventOf } from "@/shared/chatStream";
import { isUserAbortError } from "@/shared/utils/abort";

import type Anthropic from "@anthropic-ai/sdk";

// One dispatched tool, in dispatch order: which tool ran and exactly what it
// returned. The caller reads whatever it cares about off `result` — a handoff's
// entryTarget, a mutation's endedCompanyId — and this file stays ignorant of
// both. `result` is absent when dispatch never reached the handler (unknown tool
// / input that failed its parser); the error is already in `toolResults`.
export type DispatchedTool<TResult> = { name: string; result?: TResult };

export type AgentTurnResult<TResult> = {
  stopReason: string | null;
  // Assistant content blocks (text + tool_use). Caller persists these as the
  // next assistant ChatMessage row.
  content: Anthropic.ContentBlock[];
  // Tool results keyed by tool_use_id. Caller wraps these in a TOOL-role
  // ChatMessage so the next turn's history is valid for replay.
  toolResults: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
  // Pipeline widgets a tool emitted on top of its content. Caller persists
  // these as a follow-up assistant ChatMessage (one pipeline_widget block per
  // entry) AFTER the tool_results message so the order is
  // assistant(text+tool_use) → user(tool_result) → assistant(widget). The
  // runner already yielded them as live `pipeline_widget` events; this is
  // just the persistence side. Empty when no tool emitted widgets.
  emittedWidgets: Array<{
    kind: string;
    toolUseId: string;
    payload: unknown;
  }>;
  // Status lines tools emitted (see ToolResult.statusLines) — e.g. the show_*
  // tools' "Pulled up <focus-ref…/>" chip line. Caller persists these as
  // `pipeline_status` blocks on a follow-up assistant message, like
  // emittedWidgets. Empty when no tool emitted any.
  emittedStatusLines: string[];
  // The pre-minted row ids for those two follow-up messages. The runner already
  // named them in `message_start` boundaries as it streamed, so the caller MUST
  // persist under these ids — otherwise the bubbles the client painted live are
  // strangers to the rows the end-of-turn reconcile loads back, and the whole
  // turn re-shuffles on screen the moment it ends.
  widgetsMessageId: string;
  statusLinesMessageId: string;
  // Every tool this turn dispatched, in order, with its raw result. The domain
  // layer folds these into whatever it means (last handoff wins; first company
  // to end wins) — see procedures/registry/chat/runChatTurn.ts.
  dispatched: DispatchedTool<TResult>[];
  // True if the turn was cut off cleanly mid-stream — a user Stop abort or a
  // transient server↔Anthropic socket drop. Caller persists the partial +
  // surfaces the "interrupted" pill, and ends the turn without an error.
  stopped: boolean;
  // Set when the stream threw a GENUINE fault (an API 4xx/5xx that isn't a
  // socket drop, or an unexpected throw) partway through. `content` holds the
  // partial that streamed before it. The caller persists that partial (same as
  // `stopped` — save what streamed, resumable), records usage, THEN re-throws
  // this so the error still surfaces (key modal / error bubble). Null on the
  // clean paths. Mutually exclusive with `stopped`.
  errored: unknown | null;
  // Anthropic token accounting for this turn. Caller passes to recordUsage
  // with pipeline-tagged notes. Null only when the stream aborted before any
  // usage was populated (rare).
  usage: Anthropic.Usage | null;
  // Run-tree capture (admin /admin/runs). The pre-minted id of the assistant
  // ChatMessage the caller will persist for this turn — the caller passes it as
  // appendAssistantMessage({ id }) and recordUsage({ messageId }). The main loop
  // already set it on the ALS capture context so sub-agent rows recorded it as
  // their parentMessageId.
  messageId: string;
  // The actual request params this turn used (model params + tool names). The
  // caller merges in the system-prompt hash/volatile and stores on TokenUsage.
  requestParams: {
    model: string;
    maxTokens: number;
    // Null when the agent's `reasoning` isn't thinking mode.
    thinkingBudget: number | null;
    toolChoice: "auto";
    toolNames: string[];
  };
  // Accumulated sub-agent interior trace map, or null when nothing was traced.
  // Caller persists it onto the assistant row's `traces` column.
  traces: TraceMap | null;
};

type AgentTurnArgs<
  TUi,
  TKind extends string,
  TResult extends AgentToolResult<TUi, TKind>,
> = RunContext & {
  sessionId: string;
  // Where the turn's stream goes — text deltas, tool chips, panel events. Each
  // call resolves once the event is persisted and sent.
  say: (event: StreamEventOf<TUi, TKind>) => Promise<void>;
  client: Anthropic;
  model: string;
  maxTokens: number;
  // Declared by the agent this turn runs (HANK_REASONING). Only "thinking" means
  // anything here — a turn with tools and an "auto" tool_choice has nowhere to
  // put a scratchpad.
  reasoning: Reasoning;
  system: string | Anthropic.TextBlockParam[];
  tools: AgentToolDef<unknown, TResult>[];
  // Conversation messages to send. Caller is responsible for cache markers
  // (applyHistoryCacheMarker) and for ensuring the final message is USER.
  history: Anthropic.MessageParam[];
};

// Generic over what the loop carries but never reads: the panel events (`TUi`)
// and widget kinds (`TKind`) a tool emits, and the tools' full result type. The
// loop reads `content`, `error`, `events`, `widgets` and `statusLines` off a
// result (AgentToolResult) and hands every result back whole in `dispatched`,
// so whatever else the product puts on one reaches the caller untouched.
export async function runAgentTurn<
  TUi,
  TKind extends string,
  TResult extends AgentToolResult<TUi, TKind>,
>(args: AgentTurnArgs<TUi, TKind, TResult>): Promise<AgentTurnResult<TResult>> {
  const toolDefs = args.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toolInputSchema(t),
  })) as Anthropic.ToolUnion[];

  // Pre-mint the ids of every ChatMessage row this turn will produce. Two
  // separate needs, one mint: sub-agents spawned mid-turn record the assistant id
  // as their parentMessageId before the row is written (run-tree capture), and
  // the boundaries below name all three so the client groups its live bubbles
  // exactly the way the reconcile will.
  const assistantMessageId = newRunTreeId();
  const widgetsMessageId = newRunTreeId();
  const statusLinesMessageId = newRunTreeId();
  // A turn writes up to three rows and interleaves their events (tool 1's status
  // line streams before tool 2's chip completes), so the stream has to say which
  // row it's writing into as it moves between them. Deduped: re-announcing the
  // row already open is a no-op, so call it freely before any group of events.
  let openRowId: string | null = null;
  async function enterRow(messageId: string): Promise<void> {
    if (openRowId === messageId) return;
    openRowId = messageId;
    await args.say({ type: "message_start", messageId });
  }
  const traceAcc = createTraceAccumulator();
  const emitTrace = (ev: TraceEvent) => {
    traceAcc.emit(ev);
    args.trace?.onTrace?.(ev);
  };

  // How this agent reasons is declared with the agent (agent/hank/call.ts), not
  // here — the runtime just applies it. Hank is the only caller and the only
  // unforced one (tool_choice stays "auto" below), which is what makes real
  // thinking available to him at all.
  const thinkingBudget =
    args.reasoning.mode === "thinking" ? args.reasoning.budget : null;
  // Run-tree capture: the exact params this turn sends. Caller merges the
  // system-prompt hash/volatile in and stores it on the TokenUsage row.
  const requestParams: AgentTurnResult<TResult>["requestParams"] = {
    model: args.model,
    maxTokens: args.maxTokens,
    thinkingBudget,
    toolChoice: "auto",
    toolNames: args.tools.map((t) => t.name),
  };
  const stream = args.client.messages.stream(
    {
      model: args.model,
      max_tokens: args.maxTokens,
      ...(thinkingBudget === null
        ? {}
        : { thinking: { type: "enabled", budget_tokens: thinkingBudget } }),
      system: args.system,
      tools: toolDefs,
      messages: args.history,
    },
    args.signal ? { signal: args.signal } : undefined,
  );

  // Everything the model itself produces — text deltas and tool chips — lands on
  // the assistant row, so open it before the first byte arrives.
  await enterRow(assistantMessageId);

  const emittedStarts = new Set<string>();
  let final: Anthropic.Message;
  let streamStopped = false;
  // Non-null when the stream threw a genuine fault (not a Stop / socket drop).
  // We keep the partial and mark it so the caller saves-then-re-throws.
  let streamErrored: unknown = null;
  try {
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        await args.say({ type: "text", text: event.delta.text });
      } else if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use" && !HIDDEN_TOOLS.has(block.name)) {
          // Emit the chip immediately on stream — input gets upserted after
          // finalMessage resolves (the streaming partial_json deltas are
          // accumulated by the SDK).
          await args.say({
            type: "tool_use_start",
            name: block.name,
            toolUseId: block.id,
            input: {},
          });
          emittedStarts.add(block.id);
        }
      }
    }
    final = await stream.finalMessage();
  } catch (err) {
    // Whatever the failure, keep the partial that streamed — the user shouldn't
    // lose it, and either way it's resumable. A user Stop abort or a transient
    // server↔Anthropic socket drop ends the turn cleanly (streamStopped). Any
    // OTHER error is a genuine fault: we still keep + persist the partial, but
    // flag it errored so the caller re-throws after persisting — the error has
    // to surface (key modal / error bubble) WITHOUT discarding what streamed.
    const partial = stream.currentMessage;
    final = partial ?? (emptyAbortedMessage(args.model) as Anthropic.Message);
    if (isUserAbortError(err) || isTransientStreamError(err)) {
      streamStopped = true;
    } else {
      streamErrored = err;
    }
  }

  if (streamStopped || streamErrored != null) {
    // Surface partial tool_uses as interrupted chips (a cut-off tool_use has no
    // result). Same for a clean Stop and a genuine error — the caller decides
    // whether to also re-throw based on `errored`.
    for (const block of final.content) {
      if (block.type === "tool_use" && !HIDDEN_TOOLS.has(block.name)) {
        // eslint-disable-next-line no-await-in-loop -- one chip per cut-off tool, said in the order the model wrote them
        await args.say({
          type: "tool_use_complete",
          toolUseId: block.id,
          result: "interrupted",
          error: true,
        });
      }
    }
    return {
      stopReason: final.stop_reason,
      content: final.content,
      toolResults: [],
      emittedWidgets: [],
      emittedStatusLines: [],
      widgetsMessageId,
      statusLinesMessageId,
      // The stream died before any tool ran.
      dispatched: [],
      stopped: streamStopped,
      errored: streamErrored,
      usage: final.usage ?? null,
      messageId: assistantMessageId,
      requestParams,
      traces: traceAcc.snapshot(),
    };
  }

  const toolUses = final.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );

  // Re-emit tool_use_start now that input is fully assembled. Client-side
  // segment dispatcher upserts the input so the expand UI shows it.
  for (const tu of toolUses) {
    if (HIDDEN_TOOLS.has(tu.name)) continue;
    // eslint-disable-next-line no-await-in-loop -- chips are said in the order the model wrote them
    await args.say({
      type: "tool_use_start",
      name: tu.name,
      toolUseId: tu.id,
      input: tu.input,
    });
    if (!emittedStarts.has(tu.id)) emittedStarts.add(tu.id);
  }

  // Sequential dispatch. Pipeline agents rarely emit >1 tool_use per turn;
  // when they do, the order matters for the replay invariant (tool_results
  // must match tool_use order).
  const toolByName = new Map(args.tools.map((t) => [t.name, t] as const));
  const toolResults: AgentTurnResult<TResult>["toolResults"] = [];
  const emittedWidgets: AgentTurnResult<TResult>["emittedWidgets"] = [];
  const emittedStatusLines: string[] = [];
  const dispatched: DispatchedTool<TResult>[] = [];
  // Every await in this loop is ordered on purpose: tools dispatch one at a time
  // (a later call may depend on an earlier one's write, and Stop has to be able
  // to land between two of them), and each tool's chip, panel events, widgets,
  // and status lines are said in order after it finishes.
  /* eslint-disable no-await-in-loop */
  for (const tu of toolUses) {
    const hidden = HIDDEN_TOOLS.has(tu.name);
    let content = "";
    // Whatever a handler put in `events` / `widgets`, relayed untouched.
    let uiEvents: TUi[] = [];
    let widgets: AgentToolWidget<TKind>[] = [];
    let statusLines: string[] = [];
    let isError = false;
    // One of the two places a RunContext is assembled (the other is
    // runUserMessage opening the run). Everything below this point — the
    // handler, the procedure it enters, the sub-agents that procedure drives —
    // threads this verbatim. The accumulating emitTrace captures sub-agent
    // interiors for the run tree AND forwards to any live sink; naming this
    // tool's own id as the parent is what nests its children under its chip.
    const ctx: ToolContext = {
      userId: args.userId,
      sessionId: args.sessionId,
      signal: args.signal,
      trace: { onTrace: emitTrace, parentToolUseId: tu.id },
      runId: args.runId,
      timeZone: args.timeZone,
    };
    // Back to the assistant row: the previous iteration may have left the stream
    // writing into the widget or status row.
    await enterRow(assistantMessageId);
    const tool = toolByName.get(tu.name);
    dispatched.push({ name: tu.name });
    if (!tool) {
      content = toolErrorContent(
        "DISPATCH_ERROR",
        `unknown tool: ${tu.name}`,
        "dispatch:unknown_tool",
      );
      isError = true;
    } else {
      const parsed = tool.parser.safeParse(tu.input);
      if (!parsed.success) {
        content = toolErrorContent(
          "INVALID_INPUT",
          `invalid input for ${tu.name}: ${parsed.error.issues
            .map((i) => `${i.path.join(".")} - ${i.message}`)
            .join("; ")}`,
          `${tu.name}:invalid_input`,
        );
        isError = true;
      } else {
        try {
          // Run-tree capture: set the ALS context so any sub-agent this handler
          // spawns records its runId / parentMessageId / parentToolUseId without
          // per-call-site threading.
          const r = await withCaptureContext(
            {
              runId: args.runId,
              messageId: assistantMessageId,
              parentToolUseId: tu.id,
            },
            () => tool.handle(parsed.data, ctx),
          );
          content = r.content;
          uiEvents = r.events ?? [];
          widgets = r.widgets ?? [];
          statusLines = r.statusLines ?? [];
          dispatched[dispatched.length - 1].result = r;
          isError = r.error != null;
        } catch (err) {
          if (isUserAbortError(err)) {
            if (!hidden) {
              await args.say({
                type: "tool_use_complete",
                toolUseId: tu.id,
                result: "stopped by user",
                error: true,
              });
            }
            return {
              stopReason: final.stop_reason,
              content: final.content,
              toolResults,
              emittedWidgets,
              emittedStatusLines,
              widgetsMessageId,
              statusLinesMessageId,
              dispatched,
              stopped: true,
              errored: null,
              usage: final.usage ?? null,
              messageId: assistantMessageId,
              requestParams,
              traces: traceAcc.snapshot(),
            };
          }
          content = toolErrorContent(
            "DISPATCH_ERROR",
            `tool ${tu.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            `${tu.name}:exception`,
          );
          isError = true;
        }
      }
    }
    toolResults.push({
      tool_use_id: tu.id,
      content,
      ...(isError ? { is_error: true } : {}),
    });
    if (!hidden) {
      // Unset counts as true (see AgentToolDef.affectsViewedState). A tool that
      // wasn't found never gets here without isError.
      const affectsViewedState = !isError && (tool?.affectsViewedState ?? true);
      await args.say({
        type: "tool_use_complete",
        toolUseId: tu.id,
        result: content,
        ...(isError ? { error: true } : {}),
        ...(affectsViewedState ? { affectsViewedState: true } : {}),
      });
      for (const ui of uiEvents) {
        await args.say({ type: "ui", event: ui });
      }
      // Widgets and status lines are persisted as their own follow-up rows (see
      // runHankTurn), so the stream moves into them here and back to the
      // assistant row at the top of the next iteration.
      if (widgets.length > 0) await enterRow(widgetsMessageId);
      for (const w of widgets) {
        emittedWidgets.push(w);
        await args.say({
          type: "pipeline_widget",
          toolUseId: w.toolUseId,
          kind: w.kind,
          payload: w.payload,
        });
      }
      if (statusLines.length > 0) await enterRow(statusLinesMessageId);
      for (const line of statusLines) {
        emittedStatusLines.push(line);
        await args.say({ type: "pipeline_status", text: line });
      }
    }
  }
  /* eslint-enable no-await-in-loop */

  return {
    stopReason: final.stop_reason,
    content: final.content,
    toolResults,
    emittedWidgets,
    emittedStatusLines,
    widgetsMessageId,
    statusLinesMessageId,
    dispatched,
    stopped: false,
    errored: null,
    usage: final.usage ?? null,
    messageId: assistantMessageId,
    requestParams,
    traces: traceAcc.snapshot(),
  };
}
