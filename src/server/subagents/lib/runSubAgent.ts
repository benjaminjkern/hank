// The scaffolding EVERY sub-agent runs on — the one thing that executes a
// `SubAgentDef`. A registry file owns its prompt, its model, its input
// rendering, and its output parsing; resolving a client for the model it named,
// metering the spend, capturing the run, and the trace plumbing all live here,
// identically for all of them. If a registry file (or worse, a procedure) is
// doing any of that by hand, it has drifted and should come back.
//
// The contract — the two axes, the two kinds of `tools` entry, why there is only
// one entry point — is documented on `SubAgentDef` in ./types.ts. Read that
// first; this file is the machinery.

import Anthropic from "@anthropic-ai/sdk";

import type { RunContext, RunTrace } from "@/server/agent/contracts";
import type {
  AnyToolDef,
  ToolContext,
  ToolDef,
} from "@/server/agent/tools/lib/types";
import {
  SCRATCHPAD_FIELD,
  SCRATCHPAD_SCHEMA_NOTE,
  scratchpadProperty,
} from "@/server/platform/llm/reasoning";
import {
  resolveLlmClient,
  type ResolvedLlm,
} from "@/server/platform/llm/resolveClient";
import { traceText } from "@/server/platform/trace/traceText";
import type { TraceEvent } from "@/server/platform/trace/types";
import {
  recordUsage,
  type UsageOperation,
} from "@/server/platform/usage/track";
import { isUserAbortError } from "@/utils/abort";

import { recordSubAgentRun, redactCaptureContent } from "./subAgentRun";

import type {
  SubAgentDef,
  SubAgentOutputSchema,
  SubAgentResult,
  SubAgentRunOptions,
} from "./types";

// A def resolved against one input: every "or a function of the input" field
// collapsed to its value, and every default filled in. The loop below works on
// this rather than on the def, so the input renders exactly once (the user
// content can be hundreds of KB) and the loop never has to know about generics.
type ResolvedCall = {
  operation: UsageOperation;
  maxTokens: number;
  // Non-null only for `reasoning: {mode:"thinking"}`. A scratchpad needs nothing
  // here — it was already folded into the output schema below.
  thinkingBudget: number | null;
  maxTurns: number;
  forceOutputFromTurn: number;
  forceOutputAttempts: number;
  // null = prose mode (the def declared no schema).
  outputSchema: SubAgentOutputSchema | null;
  readTools: AnyToolDef[];
  serverTools: Anthropic.ToolUnion[];
  system: string | Anthropic.TextBlockParam[] | undefined;
  userContent: string | Anthropic.ContentBlockParam[];
  usageNote: (turn: number) => string;
};

export async function runSubAgent<TInput, TOutput, TResult>(
  def: SubAgentDef<TInput, TOutput, TResult>,
  input: TInput,
  ctx: RunContext,
  // Harness-only; see `SubAgentRunOptions`. Production calls pass three args.
  opts?: SubAgentRunOptions,
): Promise<SubAgentResult<TResult>> {
  let resolved: ResolvedLlm;
  try {
    resolved = await resolveLlmClient(ctx.userId, { model: def.model });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      turns: 0,
      usage: [],
    };
  }

  const call = resolveCall(def, input, opts?.toolDoubles);

  const caption =
    typeof def.caption === "function" ? def.caption(input) : def.caption;
  if (caption) traceText(ctx.trace, caption);

  // A user abort propagates out of here rather than returning — the caller has
  // to see a real stop, not a recoverable sub-agent failure. It's also why the
  // capture below is skipped on abort: nothing happened worth auditing.
  const result = await runSubAgentLoop<TOutput>(call, ctx, resolved);

  if (!result.ok) traceText(ctx.trace, `${def.name}: ${result.error}`);

  await recordSubAgentRun({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    operation: def.name,
    model: resolved.model,
    // The persisted class is exactly "did this run get read tools" — the only
    // mechanical difference there has ever been between the two. Derived rather
    // than declared so it can't disagree with what actually ran.
    klass: call.readTools.length > 0 ? "judgement" : "transform",
    ok: result.ok,
    outputSchemaName: result.ok ? (result.outputSchemaName ?? null) : null,
    input: {
      system: call.system,
      initialUserContent: redactCaptureContent(call.userContent),
    },
    // Prose output (no schema ended the loop, so no name) is wrapped so every
    // row in the column stays a JSON object, matching the shape the runtime
    // auditor has always read. The RAW emission is captured, not the parsed
    // result — parsing is the def's interpretation, and the audit wants what the
    // model actually said.
    output: result.ok
      ? result.outputSchemaName == null
        ? { text: result.output }
        : result.output
      : undefined,
    error: result.ok ? null : result.error,
    turns: result.turns,
  });

  if (!result.ok) return result;
  const parse = def.parse;
  if (!parse) return result as unknown as SubAgentResult<TResult>;

  // A `parse` that throws is rejecting a structurally-wrong emission (see the
  // field's doc comment) — surface it as an ordinary failure so callers have one
  // shape to handle.
  try {
    return {
      ...result,
      output: parse(result.output, input, {
        outputSchemaName: result.outputSchemaName ?? null,
        turns: result.turns,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      usage: result.usage,
      turns: result.turns,
    };
  }
}

function resolveCall<TInput, TOutput, TResult>(
  def: SubAgentDef<TInput, TOutput, TResult>,
  input: TInput,
  toolDoubles: AnyToolDef[] | undefined,
): ResolvedCall {
  const declared = def.outputSchema ?? null;
  const scratchpad =
    def.reasoning.mode === "scratchpad" ? def.reasoning.guidance : null;
  if (scratchpad !== null && declared === null) {
    throw new Error(
      `${def.name}: reasoning mode "scratchpad" needs an output schema to put the ${SCRATCHPAD_FIELD} field in — a prose sub-agent has nowhere to inject it (use "thinking", which prose mode can actually have).`,
    );
  }
  const outputSchema =
    declared === null || scratchpad === null
      ? declared
      : withScratchpad(declared, scratchpad);
  const maxTurns = def.maxTurns ?? 1;
  const usageNotes = def.usageNotes;
  return {
    operation: def.name,
    maxTokens: def.maxTokens,
    thinkingBudget:
      def.reasoning.mode === "thinking" ? def.reasoning.budget : null,
    maxTurns,
    forceOutputFromTurn: def.forceOutputFromTurn ?? maxTurns,
    forceOutputAttempts: Math.max(1, def.forceOutputAttempts ?? 3),
    outputSchema,
    readTools: applyToolDoubles(
      (typeof def.readTools === "function"
        ? def.readTools(input)
        : def.readTools) ?? [],
      toolDoubles,
      def.name,
    ),
    serverTools: def.serverTools ?? [],
    system: typeof def.system === "function" ? def.system(input) : def.system,
    userContent: def.userContent(input),
    usageNote: (turn) =>
      typeof usageNotes === "function"
        ? usageNotes(input, turn)
        : (usageNotes ?? `turn=${turn}`),
  };
}

// Swap in the harness's fixture-backed handlers for tools the def declared,
// matched by name. Substitution-only by design: a double for a tool the def
// didn't declare is a harness bug, and silently honoring it would let a fixture
// hand the model a capability production never gives it.
function applyToolDoubles(
  declared: AnyToolDef[],
  doubles: AnyToolDef[] | undefined,
  subAgentName: string,
): AnyToolDef[] {
  if (!doubles?.length) return declared;
  const byName = new Map(doubles.map((t) => [t.name, t]));
  const swapped = declared.map((t) => byName.get(t.name) ?? t);
  const undeclared = [...byName.keys()].filter(
    (name) => !declared.some((t) => t.name === name),
  );
  if (undeclared.length) {
    throw new Error(
      `${subAgentName}: tool double(s) [${undeclared.join(", ")}] name no tool this sub-agent declares — a double replaces a tool, it can't add one.`,
    );
  }
  return swapped;
}

// Prepend the private `analysis` field to an output schema. Property ORDER is
// what actually makes the model fill it first — a JSON-schema object has no
// "required order", so the only lever is that the field appears before the real
// ones in the emitted properties — hence the spread rather than an assignment,
// and `required` so it can't be quietly omitted. `guidance` is a plain string
// per def (never a function of the input), so the injected schema is identical
// on every call and the tools-block cache prefix still holds.
function withScratchpad(
  schema: SubAgentOutputSchema,
  guidance: string,
): SubAgentOutputSchema {
  const properties =
    (schema.inputSchema.properties as Record<string, unknown> | undefined) ??
    {};
  const required = Array.isArray(schema.inputSchema.required)
    ? (schema.inputSchema.required as string[])
    : [];
  return {
    ...schema,
    description: `${schema.description} ${SCRATCHPAD_SCHEMA_NOTE}`,
    inputSchema: {
      ...schema.inputSchema,
      properties: {
        [SCRATCHPAD_FIELD]: scratchpadProperty(guidance),
        ...properties,
      },
      required: [SCRATCHPAD_FIELD, ...required],
    },
  };
}

async function runSubAgentLoop<TOutput>(
  call: ResolvedCall,
  ctx: RunContext,
  resolved: ResolvedLlm,
): Promise<SubAgentResult<TOutput>> {
  // No schema = the product is prose. Nothing to force, and the loop ends on the
  // first turn the model answers without reaching for a read tool.
  const proseMode = call.outputSchema === null;

  // Extend the ceiling past maxTurns so forcing gets N shots. Only PAST
  // maxTurns, so healthy runs — which return the moment the model commits —
  // never see the extra turns; they exist solely for the would-otherwise-fail
  // path where the model ignores a forced tool_choice.
  const hardStop = proseMode
    ? call.maxTurns
    : Math.max(
        call.maxTurns,
        call.forceOutputFromTurn + call.forceOutputAttempts - 1,
      );

  const outputSchemaName = call.outputSchema?.name ?? null;
  const toolByName = new Map<string, AnyToolDef>(
    call.readTools.map((t) => [t.name, t]),
  );
  // The ambient ctx, forwarded — a read tool runs for the same user, under the
  // same abort signal, inside the same run. Read tools are user-scoped; the
  // session only rides along for handlers that want it, and every call site that
  // declares readTools runs inside one.
  const toolCtx: ToolContext = { ...ctx, sessionId: ctx.sessionId ?? "" };

  const tools: Anthropic.ToolUnion[] = withToolsCacheMarker([
    ...call.readTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    })),
    ...call.serverTools,
    ...(call.outputSchema
      ? [
          {
            name: call.outputSchema.name,
            description: call.outputSchema.description,
            input_schema: call.outputSchema
              .inputSchema as Anthropic.Tool["input_schema"],
          },
        ]
      : []),
  ]);

  const system =
    call.system === undefined ? undefined : withSystemCacheMarker(call.system);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: withInitialUserCacheMarker(call.userContent) },
  ];
  const usage: Anthropic.Usage[] = [];

  for (let turn = 1; turn <= hardStop; turn++) {
    const shouldForceOutput = !proseMode && turn >= call.forceOutputFromTurn;
    let resp: Anthropic.Message;
    try {
      // `reasoning: {mode:"thinking"}`. Incompatible with a forced tool_choice,
      // so when it's on we always use "auto" and lean on the no-tool nudge to
      // land the final call — which is why it's only declared by prose-mode
      // sub-agents (nothing to force) and by the decider audit's thinking-vs-
      // scratchpad A/B. max_tokens must exceed the thinking budget, so raise it
      // by the budget when thinking is on.
      const thinkingBudget = call.thinkingBudget;
      // eslint-disable-next-line no-await-in-loop -- an agent turn's input is the previous turn's response plus its tool results
      resp = await resolved.client.messages.create(
        {
          model: resolved.model,
          max_tokens:
            thinkingBudget === null
              ? call.maxTokens
              : call.maxTokens + thinkingBudget,
          system,
          ...(thinkingBudget === null
            ? {}
            : {
                thinking: {
                  type: "enabled" as const,
                  budget_tokens: thinkingBudget,
                },
              }),
          // A prose one-shot with no read tools sends no tools at all — there'd
          // be nothing in the array to choose from.
          ...(tools.length > 0
            ? {
                tools,
                // Force an output schema on the last allowed turn (or earlier if
                // the def set forceOutputFromTurn) so we never come back
                // empty-handed. Earlier turns leave the model free to call read
                // tools. Thinking on → always "auto" (forcing is incompatible
                // with extended thinking).
                tool_choice:
                  thinkingBudget !== null
                    ? { type: "auto" }
                    : shouldForceOutput && outputSchemaName !== null
                      ? { type: "tool", name: outputSchemaName }
                      : {
                          type: "auto",
                        },
              }
            : {}),
          messages,
        },
        ctx.signal ? { signal: ctx.signal } : undefined,
      );
    } catch (err) {
      // A user-initiated abort propagates out so the caller can handle it as a
      // real stop rather than a recoverable sub-agent failure (which would
      // otherwise let this loop continue to the next turn, and let the parent
      // carry on working after Stop). Callers that abort their OWN siblings
      // deliberately — the scan fan-out hitting a rate-limit wall — catch it.
      if (isUserAbortError(err)) throw err;
      return {
        ok: false,
        error: `sub-agent API call failed at turn ${turn}: ${err instanceof Error ? err.message : String(err)}`,
        status: err instanceof Anthropic.APIError ? err.status : undefined,
        usage,
        turns: turn - 1,
      };
    }
    usage.push(resp.usage);
    // eslint-disable-next-line no-await-in-loop -- meters the response the line above just received
    await recordUsage({
      userId: ctx.userId,
      operation: call.operation,
      model: resolved.model,
      usage: resp.usage,
      sessionId: ctx.sessionId,
      notes: call.usageNote(turn),
      // Only a genuinely dispatched read tool earns a toolName. A turn that
      // committed to an output schema has no tool call to attribute, so this is
      // null there — `operation` attributes the spend and SubAgentRun records
      // which schema was emitted. (Was: the schema name, which made sub-agent
      // output shapes indistinguishable from real tools in `pnpm usage`.)
      toolName: firstReadToolName(resp.content, outputSchemaName),
      billedToServer: resolved.billedToServer,
    });

    // Emit trace events for each text block the model produced this turn. Done
    // before the output short-circuit so a sub-agent that mixes reasoning text
    // with its output emission still surfaces the text — and so a prose
    // sub-agent's answer reaches the chip without its caller re-emitting it.
    for (const block of resp.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        traceText(ctx.trace, block.text);
      }
    }

    // Truncation: if the model hit max_tokens mid-emission, the tool_use block
    // (if any) has partial input — JSON-parsable but missing entries (e.g. a
    // bucketedCloses array that ends mid-element). Surfacing that as a success
    // would silently process a tiny subset of the model's intended payload,
    // which is exactly the failure mode this check exists for. Prose truncates
    // just as badly (a summary that stops mid-sentence becomes the session's
    // running summary). Treat as failure so the caller can raise maxTokens /
    // chunk smaller / retry.
    if (resp.stop_reason === "max_tokens") {
      return {
        ok: false,
        error: `sub-agent hit max_tokens (${call.maxTokens}) at turn ${turn}; output likely truncated. Raise maxTokens or split input.`,
        usage,
        turns: turn,
      };
    }

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (proseMode) {
      // The answer is whatever it wrote once it stopped reaching for tools.
      if (toolUses.length === 0) {
        const text = joinText(resp.content);
        // An empty completion is a failure, not an empty answer — the one prose
        // sub-agent's product becomes the session's running summary, and
        // "successfully summarized to nothing" would truncate the transcript
        // with nothing standing in for it.
        if (!text) {
          return {
            ok: false,
            error: "sub-agent returned no text",
            usage,
            turns: turn,
          };
        }
        return {
          ok: true,
          output: text as TOutput,
          outputSchemaName: null,
          usage,
          turns: turn,
        };
      }
    } else {
      // An emitted output schema ends the loop regardless of what else the
      // response carries.
      const outputUse = toolUses.find((b) => b.name === outputSchemaName);
      if (outputUse) {
        return {
          ok: true,
          outputSchemaName: outputUse.name,
          output: outputUse.input as TOutput,
          usage,
          turns: turn,
        };
      }
      if (toolUses.length === 0) {
        // Model stopped without any tool call and without an output. Push a
        // nudge and loop; the forced choice will catch it if it keeps refusing.
        // An empty content array can't be echoed back (the API rejects it), so
        // stand in a placeholder — DeepSeek does occasionally return one.
        messages.push({
          role: "assistant",
          content:
            resp.content.length > 0
              ? resp.content
              : [{ type: "text", text: "(no output)" }],
        });
        messages.push({
          role: "user",
          content: `You did not call any tool. Call ${outputSchemaName} with your answer now.`,
        });
        continue;
      }
    }

    // Dispatch the read-tool calls and append the assistant + tool_result turns
    // for the next iteration.
    messages.push({ role: "assistant", content: resp.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const parent = ctx.trace?.parentToolUseId;
      // Emit a trace_tool_start so the live UI can show the read-tool running
      // before its result lands.
      if (ctx.trace?.onTrace && parent) {
        ctx.trace.onTrace({
          type: "trace_tool_start",
          toolUseId: use.id,
          name: use.name,
          input: use.input,
          parentToolUseId: parent,
        });
      }
      const toolDef = toolByName.get(use.name);
      if (!toolDef) {
        const errContent = `unknown tool: ${use.name}`;
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: errContent,
          is_error: true,
        });
        emitToolComplete(ctx.trace, use, errContent, true);
        continue;
      }
      try {
        const parsed = toolDef.parser.parse(use.input);
        // eslint-disable-next-line no-await-in-loop -- read tools dispatch in order, and Stop has to be able to land between two of them
        const result = await toolDef.handle(parsed, toolCtx);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: result.content,
          is_error: result.error != null,
        });
        emitToolComplete(ctx.trace, use, result.content, result.error != null);
      } catch (err) {
        if (isUserAbortError(err)) throw err;
        const errContent = `tool error: ${err instanceof Error ? err.message : String(err)}`;
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: errContent,
          is_error: true,
        });
        emitToolComplete(ctx.trace, use, errContent, true);
      }
    }
    // On a forced turn the model was told to emit its output but called a read
    // tool instead (DeepSeek ignoring tool_choice). Append an explicit reminder
    // to the tool_result user turn so the next forced attempt commits rather
    // than exploring again. (Text + tool_result blocks coexist fine in one
    // user message.)
    const content: Anthropic.ContentBlockParam[] = shouldForceOutput
      ? [
          ...toolResults,
          {
            type: "text",
            text: `Stop calling read tools. Call ${outputSchemaName} now with your final answer, using what you already have.`,
          },
        ]
      : toolResults;
    messages.push({ role: "user", content });
  }

  return {
    ok: false,
    error: proseMode
      ? `sub-agent exhausted ${hardStop} turns without answering`
      : `sub-agent exhausted ${hardStop} turns without emitting ${outputSchemaName}`,
    usage,
    turns: hardStop,
  };
}

function emitToolComplete(
  trace: RunTrace | undefined,
  use: Anthropic.ToolUseBlock,
  result: string,
  error: boolean,
): void {
  if (!trace?.onTrace || !trace.parentToolUseId) return;
  trace.onTrace({
    type: "trace_tool_complete",
    toolUseId: use.id,
    name: use.name,
    result,
    ...(error ? { error: true as const } : {}),
    parentToolUseId: trace.parentToolUseId,
  } satisfies TraceEvent);
}

function joinText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// The first REAL tool this turn dispatched, for usage attribution. An emitted
// output schema arrives as a tool_use block too, so it has to be filtered out
// by name — otherwise the sub-agent's return shape gets metered as a tool call.
function firstReadToolName(
  content: Anthropic.ContentBlock[],
  outputSchemaName: string | null,
): string | undefined {
  for (const b of content) {
    if (b.type === "tool_use" && b.name !== outputSchemaName) return b.name;
  }
  return undefined;
}

// Add ephemeral cache_control to the last block of `system`. Anthropic caches
// the prefix up to (and including) the marked block, so this caches the entire
// system prompt across turns of the same sub-agent loop. (A no-op on DeepSeek,
// which auto-caches by prefix and strips the field.)
function withSystemCacheMarker(
  system: string | Anthropic.TextBlockParam[],
): Anthropic.TextBlockParam[] {
  if (typeof system === "string") {
    return [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
    ];
  }
  if (system.length === 0) return system;
  const out = system.slice();
  const i = out.length - 1;
  out[i] = { ...out[i], cache_control: { type: "ephemeral" } };
  return out;
}

// Mark the last tool definition with cache_control so the entire tools array
// caches as part of the request prefix. Tools don't change turn-to-turn, so this
// is a pure win on turn 2+.
function withToolsCacheMarker(
  tools: Anthropic.ToolUnion[],
): Anthropic.ToolUnion[] {
  if (tools.length === 0) return tools;
  const out = tools.slice();
  const i = out.length - 1;
  out[i] = {
    ...out[i],
    cache_control: { type: "ephemeral" },
  };
  return out;
}

// For string inputs, wrap into a single cached block — the common case for defs
// that don't care about cache boundaries inside the user message. For array
// inputs, leave the def's cache_control markers untouched: defs that split a
// stable prefix from a chunk-varying tail want the marker on the prefix, not the
// tail.
function withInitialUserCacheMarker(
  content: string | Anthropic.ContentBlockParam[],
): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") {
    return [
      { type: "text", text: content, cache_control: { type: "ephemeral" } },
    ];
  }
  return content;
}
