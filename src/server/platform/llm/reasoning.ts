// How an LLM call reasons BEFORE it answers — the one vocabulary for it, shared
// by the main agent (agent/hank/call.ts) and every sub-agent (SubAgentDef).
//
// Domain-blind like the rest of platform/: this names no company, job,
// opportunity, or contact, and imports nothing from the domain side. It sits
// beside models.ts for the symmetry — a call declares `model: LlmModel` from
// there and `reasoning: Reasoning` from here.
//
// WHY THIS IS A DECLARED FIELD AND NOT A DEFAULT. There are two ways to make a
// model reason before it commits, and which one is even AVAILABLE depends on the
// call:
//
//   - Extended thinking is the real thing, but it is incompatible with a forced
//     `tool_choice` (DeepSeek answers "Thinking mode does not support this
//     tool_choice", HTTP 400). Every sub-agent that emits an output schema
//     forces one, so thinking is off the table for all but the prose ones.
//   - A scratchpad is the substitute that works under a forced tool_choice: a
//     leading private `analysis` field the model fills before any real field.
//     It costs output tokens in the same way thinking does, and it has the extra
//     property that the reasoning is CAPTURED (it lands in SubAgentRun.output),
//     so an audit can read what the model actually weighed.
//
// It is REQUIRED on every def, next to `maxTokens`, so the choice is visible:
// you cannot add a sub-agent without saying how it thinks. A default would let
// one silently ship with no reasoning at all.

export type Reasoning =
  // A leading private `analysis` field, prepended to the output schema(s) by the
  // runner. The right answer for anything that emits a schema.
  | { mode: "scratchpad"; guidance: string }
  // Real extended thinking. Only available when nothing is forced — i.e. the
  // main agent (tool_choice "auto") and prose-mode sub-agents (no tools at all).
  | { mode: "thinking"; budget: number }
  // Deliberately neither. `why` is required so this reads as a decision someone
  // made rather than a field someone forgot: the bar is a pure extraction with
  // nothing to weigh (pull the stated salary out of this posting), not "it
  // seemed fine without one".
  | { mode: "none"; why: string };

// The property name, one place. Every scratchpad in the repo is called this.
export const SCRATCHPAD_FIELD = "analysis";

// The half of a scratchpad's description that is the same everywhere: the model
// never sees the user, it fills this before anything else, and — the part that
// actually earns its tokens — the rest of the emission has to MATCH what it
// concluded here. A decision that contradicts its own analysis was the most
// common failure across scan-job, pre-scan, and the critic alike, which is why
// the sentence is worth stating identically in all of them.
const PREAMBLE =
  "PRIVATE scratchpad — the user never sees this. Fill it FIRST, before any other field.";
const DISCIPLINE =
  "Do ALL your reconsidering HERE. Then fill every other field to match the conclusion you reached — never emit a value that contradicts your own analysis. That contradiction is the single most common failure in this call.";

// The JSON-schema property the runner prepends. Takes the def's own guidance —
// what to actually walk through, which is the only part that differs per call —
// and wraps it in the shared framing.
export function scratchpadProperty(guidance: string): {
  type: "string";
  description: string;
} {
  return {
    type: "string",
    description: `${PREAMBLE}\n\n${guidance}\n\n${DISCIPLINE}`,
  };
}

// Appended to the output schema's own description, so the instruction lands in
// both places the model reads (the tool description and the field).
export const SCRATCHPAD_SCHEMA_NOTE = `Fill \`${SCRATCHPAD_FIELD}\` FIRST, then fill every other field to match it.`;
