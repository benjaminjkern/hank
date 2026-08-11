// Finish a stretch of work: consolidate memory, compact the transcript, and
// relay what happened to Hank. Session lifecycle only — the caller owns the
// panel (it already has `buildShowEvents` for dropping back to the dashboard)
// because emitting UI events is the runner's job, not a procedure's.
//
// `subject` names what just ended, and it is the ONLY thing that varies: a
// company the user finished, or a round of adding companies they said they were
// done with. Both are the same event — a topic boundary, after which the
// transcript ahead of it is worth summarizing and what it revealed is worth
// keeping.
//
// It must NOT be called from the company-status writes themselves, for two
// reasons. Layering: those exist to make several related WRITES happen
// canonically in one call, while this chains two sub-agent calls and truncates
// the transcript — a session-lifecycle concern a company mutation has no
// business knowing how to do. And cost: the set-aside tools aren't handoffs, so
// "close these three" is ONE turn with three calls. `runCompactSession`
// self-limits after the first (it advances `summarizedUpToMessageId`), but
// `runConsolidateSessionMemory` has no such guard and would re-run in full each
// time.
//
// So it runs at most ONCE per user message, from a caller that knows the
// message ended something: the chat runner off `endedCompanyId`, or the
// add-more dispatch when the user says they're done adding.

import type { RunContext } from "@/server/agent/contracts";
import { appendPipelineActivity } from "@/server/agent/session";
import { withTraceSpan } from "@/server/platform/trace/span";
import { runCompactSession } from "@/server/procedures/registry/compactSession";
import { runConsolidateSessionMemory } from "@/server/procedures/registry/consolidateSessionMemory";

export type WrapSubject = "company" | "discovery";

export async function runWrapSegment(
  args: RunContext & { sessionId: string; subject: WrapSubject },
): Promise<void> {
  return await withTraceSpan("wrap_segment", args.trace, (trace) =>
    wrapSegment({ ...args, trace }),
  );
}

const WHAT_ENDED: Record<WrapSubject, string> = {
  company: "the company just finished",
  discovery: "the round of adding companies the user just finished",
};

async function wrapSegment(
  args: RunContext & { sessionId: string; subject: WrapSubject },
): Promise<void> {
  await runConsolidateSessionMemory(args);
  const compacted = await runCompactSession(args);

  // Relay this otherwise-silent bookkeeping to Hank. Consolidation + compaction
  // just rewrote his saved notes and truncated the transcript; without a note
  // he'd find memory changed and older turns gone with no signal. Persisted
  // AFTER runCompactSession so it lands past the new cutoff and survives the
  // replay — that ordering is load-bearing. Hank-only (pipeline_activity): the
  // user sees none of this. Best-effort — a failed note must never break the
  // wrap.
  const ended = WHAT_ENDED[args.subject];
  const note = compacted.compacted
    ? `Wrapped up ${ended}: consolidated what you covered into the user's saved notes, and condensed the earlier part of this conversation into the running summary (shown at the top of this context). Your notes/memory are current; the older turns now live in that summary rather than the full transcript. This was internal cleanup — nothing to mention to the user.`
    : `Wrapped up ${ended}: consolidated what you covered into the user's saved notes. The conversation was short enough to leave intact. This was internal cleanup — nothing to mention to the user.`;
  try {
    await appendPipelineActivity(args.sessionId, note);
  } catch (err) {
    console.warn(`[runWrapSegment] activity relay failed:`, err);
  }
}
