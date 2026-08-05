// The shape EVERY sub-agent is declared in — the sub-agent equivalent of
// `ToolDef` (agent/tools/lib/types.ts): a registry file holds ONE `SubAgentDef`
// literal describing the LLM call, and nothing runs it but
// [`runSubAgent`](./runSubAgent.ts). See docs/sub-agents.md for how to pick a
// shape; this file is the contract.
//
// A def declares WHAT the call is; the caller supplies WHO it runs for. Hence
// `runSubAgent`'s two arguments: `input` (the sub-agent's own domain input) and
// `ctx` (a [`RunContext`](../../agent/contracts/runContext.ts) — user, trace,
// abort). Nothing about how the call is SHAPED rides on ctx.
//
// Three independent axes shape it, and between them they cover every sub-agent
// in the repo: whether `readTools` are declared (iterative loop vs one-shot),
// whether an `outputSchema` is declared (JSON payload vs prose), and how
// `reasoning` says the model works before it commits.
//
// TWO KINDS OF `tools` ENTRY RIDE THE LOOP, and conflating them is the bug this
// file's naming exists to prevent:
//   - `readTools` are REAL tools. The loop dispatches them against the same
//     `ToolDef.handle()` the main agent uses, traces them as tool spans, and
//     meters them under `TokenUsage.toolName`. They must be read-only — the type
//     can't enforce it, so only `SUB_AGENT_READ_TOOLS` or a read-only extension
//     of it goes in, and the caller persists after the sub-agent returns.
//   - `outputSchema` is NOT a tool. Nothing dispatches it; it exists only
//     because `tools` + `tool_choice` is the sole mechanism the Messages API
//     (and DeepSeek's compatible endpoint) offers for constraining output to a
//     JSON schema. Emitting it TERMINATES the loop and its payload is the
//     sub-agent's return value. Never trace or meter it as a tool call.

import type { AnyToolDef } from "@/server/agent/tools/lib/types";
import type { LlmModel } from "@/server/platform/llm/models";
import type { Reasoning } from "@/server/platform/llm/reasoning";
import type { UsageOperation } from "@/server/platform/usage/track";

import type Anthropic from "@anthropic-ai/sdk";

// NOT a tool — the JSON shape the model is constrained to emit. See the header.
export type SubAgentOutputSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

// What the loop knows about the emission, handed to `parse` for the cases that
// need it.
export type SubAgentOutputMeta = {
  // Which schema ended the loop. Null in prose mode. With one schema per def
  // this is not a branch key — it survives because `SubAgentRun` records it, so
  // the audit harness can tell a committed run from a prose/failed one.
  outputSchemaName: string | null;
  turns: number;
};

export type SubAgentDef<TInput, TOutput, TResult = TOutput> = {
  // One name in three casings with the file and the exported const, and the
  // `TokenUsage.operation` / `SubAgentRun.operation` key it meters under.
  name: UsageOperation;
  // Which model this sub-agent runs on. Declared here next to its prompt, and
  // honored verbatim — nothing remaps it.
  model: LlmModel;
  // Required, not defaulted: every sub-agent has a considered cap next to its
  // prompt, and a silent default here would be a fourth thing to keep in sync.
  maxTokens: number;
  // How this sub-agent reasons before it commits — required for exactly the
  // reason `maxTokens` is. `{mode:"scratchpad"}` is the answer for anything that
  // emits an output schema (a forced tool_choice rules real thinking out); the
  // runner prepends the `analysis` field to every output schema, so the def
  // supplies only the guidance — what to walk through — and never re-writes the
  // shared "fill this first, then match it" framing. `{mode:"thinking"}` needs
  // an UNFORCED call (prose mode). `{mode:"none", why}` is for a pure extraction
  // with nothing to weigh, and has to say so.
  reasoning: Reasoning;
  // Safety cap on conversation turns; each turn is one API call, and a read-tool
  // dispatch is one turn. DEFAULT 1 — i.e. a one-shot. Raise it to opt into the
  // read-tool loop.
  maxTurns?: number;
  // 1-indexed turn from which `tool_choice` is forced to an output schema, and
  // every turn after. Defaults to `maxTurns` (only the last turn is forced), so
  // a one-shot forces immediately. Set to 1 on a multi-turn sub-agent whose
  // front-loaded context is always sufficient and whose failure mode is the
  // model writing prose instead of emitting the schema (preScanJobBatch).
  // Meaningless in prose mode — there is nothing to force.
  forceOutputFromTurn?: number;
  // How many times the forced tool_choice is attempted before the loop gives up
  // with "exhausted turns". Defaults to 3. On Anthropic a single forced turn
  // always yields the tool, but DeepSeek's Anthropic-compatible endpoint
  // intermittently IGNORES a forced tool_choice (returns text or a read-tool
  // call instead) — the sole cause of every "exhausted N turns" failure observed
  // in prod. The extra turns execute ONLY when the model hasn't committed (i.e.
  // today's failure path), never on a healthy run that returns early, so this
  // costs nothing except on the rare flake. The hard ceiling is therefore
  // `max(maxTurns, forceOutputFromTurn + forceOutputAttempts - 1)`.
  forceOutputAttempts?: number;
  // Optional: a one-shot whose entire instruction set rides with the user
  // content (the two vision parsers) sends no system prompt at all. Can be
  // pre-built TextBlockParam[] when the def wants its own cache boundaries.
  system?:
    | string
    | Anthropic.TextBlockParam[]
    | ((input: TInput) => string | Anthropic.TextBlockParam[] | undefined);
  // Renders the input into the (initial) user message. PURE + SYNCHRONOUS: no
  // DB reads, no fetches — a def describes a call, it doesn't gather for it.
  userContent: (input: TInput) => string | Anthropic.ContentBlockParam[];
  // Read-only side tools the sub-agent may call between turns. Omit for a
  // one-shot. Takes a function when the input genuinely decides. Must NOT
  // include an output schema.
  readTools?: AnyToolDef[] | ((input: TInput) => AnyToolDef[]);
  // Anthropic server-side tools (e.g. `web_search_20250305`) merged into the
  // tool list on every turn. These execute inside the API call — the dispatch
  // loop ignores their result blocks.
  serverTools?: Anthropic.ToolUnion[];
  // The one output shape this sub-agent returns. The loop terminates when the
  // model emits it. Omit for prose mode, where the loop terminates on the first
  // turn the model answers without calling a read tool and `output` is the
  // completion text.
  //
  // Deliberately ONE, not a list. A multi-output mode existed (`outputSchemas` +
  // an `outputSchemaChoice` forcing knob) and had exactly one user —
  // shortlistJobs' `decline_shortlist` — which turned out to be a decision the
  // CALLER could derive from the single shape already being emitted, and which
  // could contradict it when it didn't. Before adding it back, check that the
  // branch is genuinely a different SHAPE and not a conclusion derivable from
  // the one you already return.
  outputSchema?: SubAgentOutputSchema;
  // One-line caption surfaced as a trace_text before the sub-agent starts, so
  // the user can see what's happening inside the parent tool's chip.
  caption?: string | ((input: TInput) => string);
  // `TokenUsage.notes`. A function receives the input + the 1-indexed turn; a
  // plain string is a fixed disambiguator when one operation covers several call
  // shapes. Defaults to `turn={n}`.
  usageNotes?: string | ((input: TInput, turn: number) => string);
  // Decodes the raw emission into the domain shape the callers want — the
  // sub-agent's own output parsing, which is the half of "LLM I/O" that isn't
  // the prompt. Omit and `output` is the raw payload (or the prose text).
  //
  // THROW to reject an emission the model got structurally wrong (a `found`
  // outcome missing its URL): `runSubAgent` catches it and returns
  // `{ok:false, error}` like any other failure. Everything else — a conservative
  // default when the call FAILS, a throw the caller wants on failure — is caller
  // policy and lives at the call site, not here.
  parse?: (output: TOutput, input: TInput, meta: SubAgentOutputMeta) => TResult;
};

// The one result shape every sub-agent returns. `T` is the def's `TResult` (its
// `parse` output), or the raw payload when it declares no `parse`.
export type SubAgentResult<T> =
  | {
      ok: true;
      output: T;
      turns: number;
      // Which schema ended the loop — the branch key in multi-output mode. Null
      // in prose mode.
      outputSchemaName?: string | null;
      usage?: Anthropic.Usage[];
    }
  | {
      ok: false;
      error: string;
      turns: number;
      // The Anthropic HTTP status when the failure was an APIError (429
      // rate-limit, 529 overloaded). Fan-out callers use it to decide whether to
      // abort the batch and resume later vs. just drop the one item. The SDK
      // already retries transient 429/5xx with backoff before this fires.
      status?: number;
      usage?: Anthropic.Usage[];
    };

// Non-production options for one `runSubAgent` call. Nothing in `src/` passes
// these; they exist so a fixture harness can run the def EXACTLY as prod does.
export type SubAgentRunOptions = {
  // Fixture-backed stand-ins for read tools the def declared, matched BY NAME.
  // The def still decides which tools exist, what their schemas say, and what
  // the prompt tells the model about them — this only swaps what answers the
  // call, the same way `ctx.userId` already decides what `read_memory` returns.
  // A name that isn't in the def's `readTools` throws, so a double can only
  // replace a capability, never add one.
  //
  // This is the sanctioned shape for "the harness's synthetic candidate has no
  // rows in the database." The alternative — an input flag that makes the def
  // render differently or drop its tools under test — means the fixture grades
  // a prompt production never sends, which is the one thing an audit must not
  // do. Don't add such a flag back.
  toolDoubles?: AnyToolDef[];
};

// A def with its generics erased — for the runner's internals and for anything
// that holds sub-agents generically.

export type AnySubAgentDef = SubAgentDef<any, any, any>;
