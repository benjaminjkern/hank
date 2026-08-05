// commit_profile — Hank's "I'm done eliciting" gate. Flow:
//
//   1. Consolidate memory (push any transcript-bound facts into profile.md
//      and friends).
//   2. runProfileEnrichmentGate — the verdict gate.
//   3a. enriched → compact the transcript (step 1 already consolidated).
//   3b. not enriched → return the missing list + suggested probes to the agent
//       so it can re-elicit on the next turn.
//
// It persists no mode either way. Profile intake is derived per turn from the
// memory slots step 1 just wrote, so a passing verdict drops Hank out of intake
// on the next turn by itself — and runChatTurn reads that same flip as the
// completion that brings up the what's-next chooser.

import type { RunContext } from "@/server/agent/contracts";
import { appendPipelineActivity } from "@/server/agent/session";
import { withTraceSpan } from "@/server/platform/trace/span";
import { runCompactSession } from "@/server/procedures/registry/compactSession";
import { runConsolidateSessionMemory } from "@/server/procedures/registry/consolidateSessionMemory";
import { runProfileEnrichmentGate } from "@/server/procedures/registry/profileEnrichmentGate";

type CommitProfileResult =
  | { wrappedUp: true; summary: string }
  | { wrappedUp: false; missing: string[]; suggestedProbes: string[] };

// The sub-agent context IS the args here: every step this procedure composes is
// a sub-agent call, so it carries the context rather than re-listing its fields.
type CommitProfileArgs = RunContext & { sessionId: string };

export async function runCommitProfile(
  args: CommitProfileArgs,
): Promise<CommitProfileResult> {
  return await withTraceSpan(
    "commit_profile",
    args.trace,
    (trace) => commitProfile({ ...args, trace }),
    (r) => (r.wrappedUp ? "profile committed" : "still missing slots"),
  );
}

async function commitProfile(
  args: CommitProfileArgs,
): Promise<CommitProfileResult> {
  // Ungated: this only consolidates memory and runs the verdict gate, so it's
  // safe from any turn.

  // 1. Consolidate FIRST so the verdict gate sees post-write memory.
  await runConsolidateSessionMemory(args);

  // 2. Verdict gate. The deterministic pre-gate is part of the inventory read,
  // so obviously-full memory short-circuits before the LLM call (saves it on
  // fast commit_profile re-fires).
  const verdict = await runProfileEnrichmentGate(args);

  if (!verdict.enriched) {
    // Stay in profile mode; surface the missing list back to the agent so
    // the next turn re-elicits specifically. The agent message body should
    // quote the probes (or paraphrase them) — the runner doesn't generate
    // chat text here.
    return {
      wrappedUp: false,
      missing: verdict.missing,
      suggestedProbes: verdict.suggestedProbes,
    };
  }

  // 3a. Pass. Compact the transcript (step 1 already consolidated). Nothing to
  // clear: the profile-intake body is derived per turn from the memory slots
  // this run just filled, so the next turn drops out of intake on its own.
  const compactResult = await runCompactSession(args);

  // Relay the otherwise-silent consolidation + compaction to Hank (item 2), so
  // on the next turn he knows his notes were saved and the earlier profile
  // conversation was condensed rather than finding it gone. Hank-only; the user
  // sees nothing. Only when compaction actually truncated something. Best-effort.
  if (compactResult.compacted) {
    try {
      await appendPipelineActivity(
        args.sessionId,
        "Profile setup wrapped: consolidated what the user told you into their saved notes, and condensed the earlier part of this conversation into the running summary (shown at the top of this context). This was internal cleanup — nothing to mention to the user.",
      );
    } catch (err) {
      console.warn(`[runCommitProfile] activity relay failed:`, err);
    }
  }

  const summary = compactResult.compacted
    ? `Profile committed; compacted ${compactResult.summarizedMessageCount} earlier message${compactResult.summarizedMessageCount === 1 ? "" : "s"}.`
    : "Profile committed; chat was short so no compaction needed.";
  return { wrappedUp: true, summary };
}
