// Grader-LLM backend selector for the audit harnesses (session-audit auditor,
// qa-audit persona, sub-agent judge). These three "grader" agents run on Opus
// 4.8 and are the ONLY calls this module touches — the product code they drive
// (Hank-under-test via runUserMessage/resolveLlmClient, the sub-agent-under-test)
// stays on the Anthropic API key.
//
// Two backends, one shape:
//   - "api"          → a real `new Anthropic({ apiKey })`, billed to the API key
//                      (pay-as-you-go). Forced tool_choice, exact usage, unchanged.
//   - "subscription" → the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
//                      authenticated by a CLAUDE_CODE_OAUTH_TOKEN, billed to the
//                      developer's Claude subscription. No per-token dollar cost.
//
// Both are exposed as a `GraderClient` — an object with the same
// `messages.create(body, opts)` signature the call sites already use — so the
// existing `response.content.find(...)` / `response.usage` logic doesn't change.
// The subscription backend runs the Agent SDK and returns a SYNTHETIC
// Anthropic.Message: a `tool_use` block (when the request forced a tool) or a
// `text` block (free-form), plus mapped usage.
//
// Why a shim instead of an agentic rewrite: the Agent SDK's query() has no
// `tool_choice: {type:"tool"}` forcing knob, so we prompt-for-JSON and parse the
// reply (the sub-agent judge already works exactly this way). Keeping the shape
// identical means the harnesses are untouched except for how they obtain a client.
//
// Backend selection (`graderBackend`): subscription when CLAUDE_CODE_OAUTH_TOKEN
// is set, otherwise api. Force either way with AUDIT_LLM_BACKEND=api|subscription.
// Rollback is trivial: unset the token → back to the API path.
//
// The subscription path runs `persistSession: false`, so these calls leave no
// transcript in ~/.claude/projects/ — they are single-shot completions, and
// persisting them drowned the developer's real Claude Code conversations.

import { query } from "@anthropic-ai/claude-agent-sdk";

import type Anthropic from "@anthropic-ai/sdk";

// Minimal client shape the three graders rely on. `new Anthropic({apiKey})` is
// structurally assignable to this, and so is our subscription shim.
export interface GraderClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
}

export type GraderBackend = "api" | "subscription";

export function graderBackend(): GraderBackend {
  const forced = process.env.AUDIT_LLM_BACKEND;
  if (forced === "api" || forced === "subscription") return forced;
  return process.env.CLAUDE_CODE_OAUTH_TOKEN ? "subscription" : "api";
}

let announced = false;
function announceOnce(backend: GraderBackend): void {
  if (announced) return;
  announced = true;
  if (backend === "subscription") {
    console.log(
      "[grader] backend=subscription (Opus 4.8 grader calls billed to your Claude subscription via the Agent SDK)",
    );
  } else {
    console.log(
      "[grader] backend=api (grader calls billed to the Anthropic API key)",
    );
  }
}

// Returns the client the graders should call. On the API path this is the real
// Anthropic client the caller already built (billed to its key). On the
// subscription path it's the Agent-SDK shim, and `fallback` is ignored (may be
// null — subscription auth comes from CLAUDE_CODE_OAUTH_TOKEN, no API key needed).
export function getGraderClient(fallback: GraderClient | null): GraderClient {
  const backend = graderBackend();
  announceOnce(backend);
  if (backend === "subscription") return SUBSCRIPTION_CLIENT;
  if (!fallback) {
    throw new Error(
      "grader backend is 'api' but no Anthropic client was provided (need ANTHROPIC_API_KEY, or set CLAUDE_CODE_OAUTH_TOKEN to bill the subscription)",
    );
  }
  return fallback;
}

// ────────────────────────── subscription backend ──────────────────────────

let syntheticIdCounter = 0;

const SUBSCRIPTION_CLIENT: GraderClient = {
  messages: {
    create: subscriptionCreate,
  },
};

async function subscriptionCreate(
  body: Anthropic.MessageCreateParamsNonStreaming,
  options?: { signal?: AbortSignal },
): Promise<Anthropic.Message> {
  const system = flattenSystem(body.system);
  const forced = pickForcedTool(body);
  const transcript = flattenMessages(body.messages);

  const prompt = forced
    ? `${transcript}\n\n${jsonInstruction(forced)}`
    : transcript;

  // Forced-tool requests must yield parseable JSON; retry once with a firmer
  // nudge before giving up (the Messages API would guarantee this; the Agent
  // SDK can't, so we compensate here).
  const attempts = forced ? 2 : 1;
  let text = "";
  let usage: Anthropic.Usage = ZERO_USAGE;
  let parsed: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await runAgentQuery({
      system,
      prompt:
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous reply was not valid JSON. Output ONLY the JSON object, nothing else.`,
      model: body.model,
      signal: options?.signal,
    });
    text = res.text;
    usage = res.usage;
    if (!forced) break;
    parsed = extractJsonObject(text);
    if (parsed) break;
  }

  if (forced) {
    if (!parsed) {
      // Return a text block (no tool_use) so the call site's existing
      // "did not return <tool>" path fires loudly with the raw text, matching
      // how it would handle a non-complying model.
      return synthMessage(
        body.model,
        [{ type: "text", text, citations: null }],
        "end_turn",
        usage,
      );
    }
    const block = {
      type: "tool_use" as const,
      id: `toolu_grader_${++syntheticIdCounter}`,
      name: forced.name,
      input: parsed,
    };
    return synthMessage(body.model, [block], "tool_use", usage);
  }

  return synthMessage(
    body.model,
    [{ type: "text", text, citations: null }],
    "end_turn",
    usage,
  );
}

async function runAgentQuery(args: {
  system: string;
  prompt: string;
  model: string;
  signal?: AbortSignal;
}): Promise<{ text: string; usage: Anthropic.Usage }> {
  // Bridge the caller's AbortSignal to the SDK's AbortController.
  const controller = new AbortController();
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else
      args.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  // Force the subscription rail: strip API-key credentials from the child env
  // so they can't outrank CLAUDE_CODE_OAUTH_TOKEN in the SDK's auth precedence
  // (ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN > CLAUDE_CODE_OAUTH_TOKEN). The
  // parent process keeps ANTHROPIC_API_KEY set, so Hank-under-test (qa-audit)
  // and any other in-process API call are unaffected.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (typeof v === "string") childEnv[k] = v;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;

  let resultText: string | null = null;
  let usage: Anthropic.Usage = ZERO_USAGE;

  for await (const message of query({
    prompt: args.prompt,
    options: {
      model: args.model,
      systemPrompt: args.system,
      // Single-shot completion: no agent loop, no tools, no filesystem
      // settings/CLAUDE.md bleeding into the grader.
      maxTurns: 1,
      allowedTools: [],
      settingSources: [],
      // Don't write a transcript to ~/.claude/projects/. Every grader call is a
      // one-shot completion nobody will ever resume, and a harness run makes
      // dozens of them — persisted, they bury the developer's real Claude Code
      // conversations in the resume list (317 sessions, 56 of them grader
      // one-shots, before this was turned off). Passing `--no-session-persistence`
      // to the subprocess.
      persistSession: false,
      env: childEnv,
      abortController: controller,
    },
  })) {
    if (message.type === "assistant" && message.error) {
      throw new Error(
        `Agent SDK error (${message.error}) — check CLAUDE_CODE_OAUTH_TOKEN / subscription access`,
      );
    }
    if (message.type === "result") {
      if (message.subtype !== "success") {
        const errs =
          "errors" in message && Array.isArray(message.errors)
            ? message.errors.join("; ")
            : "";
        throw new Error(
          `Agent SDK result subtype=${message.subtype}${errs ? ` — ${errs}` : ""}`,
        );
      }
      resultText = message.result;
      usage = mapUsage(message.usage);
    }
  }

  if (resultText === null)
    throw new Error("Agent SDK produced no result message");
  return { text: resultText, usage };
}

// ────────────────────────────── helpers ──────────────────────────────

function flattenSystem(
  system: Anthropic.MessageCreateParamsNonStreaming["system"],
): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

// Serialize the (stateless, fully re-sent) message history into a plain text
// transcript. Handles the persona agent's multi-turn tool_use/tool_result
// shape as well as the single-user-message auditor/judge shape.
function flattenMessages(messages: Anthropic.MessageParam[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      parts.push(`${m.role === "user" ? "USER" : "ASSISTANT"}:\n${m.content}`);
      continue;
    }
    for (const block of m.content) {
      if (block.type === "text") {
        parts.push(
          `${m.role === "user" ? "USER" : "ASSISTANT"}:\n${block.text}`,
        );
      } else if (block.type === "tool_result") {
        parts.push(
          `SCREEN (result of your previous action):\n${toolResultText(block.content)}`,
        );
      } else if (block.type === "tool_use") {
        parts.push(
          `ASSISTANT (your previous structured \`${block.name}\` response):\n${JSON.stringify(block.input)}`,
        );
      }
    }
  }
  return parts.join("\n\n");
}

function toolResultText(
  content: Anthropic.ToolResultBlockParam["content"],
): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");
}

type ForcedTool = { name: string; schema: unknown };

// Which tool (if any) the request forced. `{type:"tool", name}` picks that tool;
// `{type:"any"}` with a single tool picks it. No tools → free-form JSON/text.
function pickForcedTool(
  body: Anthropic.MessageCreateParamsNonStreaming,
): ForcedTool | null {
  const tools = body.tools ?? [];
  const choice = body.tool_choice;
  const asTool = (t: (typeof tools)[number] | undefined): ForcedTool | null =>
    t && "input_schema" in t ? { name: t.name, schema: t.input_schema } : null;

  // "tool" forces a named tool; "any" forces *some* tool (with a single tool,
  // that one). "auto" is optional — NOT forced, so treat it as free-form.
  if (choice && choice.type === "tool") {
    return asTool(tools.find((t) => "name" in t && t.name === choice.name));
  }
  if (choice && choice.type === "any" && tools.length === 1) {
    return asTool(tools[0]);
  }
  return null;
}

function jsonInstruction(forced: ForcedTool): string {
  return [
    `Respond with ONLY a single JSON object that satisfies this JSON schema. No prose, no explanation, no tool call — just the JSON object (a plain \`\`\`json fenced block is fine):`,
    "```json",
    JSON.stringify(forced.schema, null, 2),
    "```",
  ].join("\n");
}

const ZERO_USAGE: Anthropic.Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: null,
  server_tool_use: null,
  service_tier: null,
} as Anthropic.Usage;

function mapUsage(u: Record<string, unknown>): Anthropic.Usage {
  const n = (k: string): number => (typeof u[k] === "number" ? u[k] : 0);
  return {
    input_tokens: n("input_tokens"),
    output_tokens: n("output_tokens"),
    cache_creation_input_tokens: n("cache_creation_input_tokens"),
    cache_read_input_tokens: n("cache_read_input_tokens"),
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
  } as Anthropic.Usage;
}

function synthMessage(
  model: string,
  content: unknown[],
  stopReason: "tool_use" | "end_turn",
  usage: Anthropic.Usage,
): Anthropic.Message {
  return {
    id: `msg_grader_${++syntheticIdCounter}`,
    type: "message",
    role: "assistant",
    model,
    content: content as Anthropic.ContentBlock[],
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  } as Anthropic.Message;
}

// Tolerant JSON extraction: prefer the LAST fenced ```json block that parses
// (a self-correcting model sometimes emits a bad block then a fixed one), fall
// back to the outermost {...} in the raw text. Mirrors the judge's own parser.
function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) candidates.push(m[1].trim());
  candidates.push(text);
  let parsed: Record<string, unknown> | null = null;
  for (const c of candidates) {
    const first = c.indexOf("{");
    const last = c.lastIndexOf("}");
    if (first === -1 || last === -1 || last < first) continue;
    try {
      parsed = JSON.parse(c.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      // keep the previous successful parse; try the next candidate
    }
  }
  return parsed;
}
