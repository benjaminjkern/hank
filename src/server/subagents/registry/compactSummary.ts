import {
  serializeTranscript,
  type StoredMessage,
} from "@/server/agent/session/serializeTranscript";
import type { LlmModel } from "@/server/platform/llm/models";
import type { SubAgentDef } from "@/server/subagents/lib/types";

// Compaction summary pass — the one sub-agent whose product is PROSE rather than
// a structured payload, so it declares no output schema and its `output` IS the
// summary text. It condenses the to-be-truncated slice of a chat transcript into
// ChatSession.summary. Driven by runCompactSession
// (src/server/procedures/registry/compactSession.ts), which owns the surrounding
// session bookkeeping (cutoff search, persistence); this file owns the prompt,
// the model, and the call, like every other sub-agent — and the compact-summary
// audit harness can drive it directly.

// Low-stakes summarizer — flash matches pro (same single warn on both, no
// fabrication) and is ~3x cheaper for a per-compaction call.
const MODEL: LlmModel = "deepseek-v4-flash";
const MAX_TOKENS = 1024;

const SUMMARY_SYSTEM = `You are summarizing a job-search assistant conversation so it can be safely truncated for context. The durable state — applied/skipped jobs, watchlist, memory notes — is already persisted in a database and the agent has tools to re-read it; do not restate any of that.

Capture only what would be lost without these messages:
- User preferences expressed in conversation (role types, comp, location, things to avoid)
- Unresolved threads or open questions
- Decisions in progress and partial work (e.g. cover letter drafts being iterated on)
- Things the user explicitly asked the assistant to remember
- Mid-stream corrections or clarifications

Be terse. Bullet points. <=300 words. Plain text, no preamble.`;

export type CompactSummaryInput = {
  // The slice of the session about to be truncated, as stored rows. Tool traffic
  // is kept (the default): this pass summarizes what a turn DID, not just what
  // was said.
  messages: StoredMessage[];
  // The running summary this pass folds into, when the session has been
  // compacted before.
  priorSummary: string | undefined;
};

export const compactSummarySubAgent: SubAgentDef<CompactSummaryInput, string> =
  {
    name: "compact_summary",
    model: MODEL,
    maxTokens: MAX_TOKENS,
    // This is the ONE sub-agent that could have real extended thinking — prose
    // mode sends no tools, so there's no forced tool_choice for thinking to
    // collide with (every other one forces its output schema and takes a
    // scratchpad instead). MEASURED AND REJECTED: budget=1024 scored 2/5 and 3/5
    // on the heavy-transcript fixture against 4/5 with thinking off, twice
    // flagging the same fault — the summary restating durable state the contract
    // above tells it to omit — and ran ~53s vs ~34s (2026-07-28). Same shape as
    // the applicationDecider null result: thinking never higher, sometimes lower.
    // Don't re-enable without a reason; a scratchpad isn't the alternative either,
    // since the product IS the prose and a summary that shows its work is worse.
    reasoning: {
      mode: "none",
      why: "Thinking measured worse here (see above) and a scratchpad can't apply to prose output.",
    },
    system: SUMMARY_SYSTEM,
    // No outputSchema — prose mode, so `output` is the completion text. The lib
    // traces it under the parent chip on its own, which is what we want here:
    // unlike a structured sub-agent's payload, this summary is prose the user can
    // read. (It has never been a `write_session_summary` tool span: nothing is
    // dispatched, and that name was for a tool that never existed.)
    userContent: (input) => {
      const transcript = serializeTranscript(input.messages);
      return input.priorSummary
        ? `Prior running summary:\n${input.priorSummary}\n\nAdditional messages to fold in:\n${transcript}\n\nProduce an updated single summary that merges the prior summary with what is new.`
        : `Messages to summarize:\n${transcript}`;
    },
    caption: (input) =>
      input.priorSummary
        ? "folding the last stretch into the running summary…"
        : "summarizing the conversation so far…",
  };
