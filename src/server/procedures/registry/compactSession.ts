// Truncate a chat session: summarize everything past the keep-window into
// ChatSession.summary and advance the cutoff pointer. That is the whole job.
//
// Memory consolidation is deliberately NOT in here — it's a separate step the
// callers compose ahead of this one (`runConsolidateSessionMemory` → this), so
// the summary is written over post-consolidation memory.

import { Role } from "@/generated/prisma/client";
import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { withTraceSpan } from "@/server/platform/trace/span";
import { traceText } from "@/server/platform/trace/traceText";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import { compactSummarySubAgent } from "@/server/subagents/registry/compactSummary";

type CompactResult =
  | { compacted: false; reason: "too_short" | "summary_failed" }
  | { compacted: true; summarizedMessageCount: number };

export async function runCompactSession(
  args: RunContext & { sessionId: string; keepLastN?: number },
): Promise<CompactResult> {
  return await withTraceSpan(
    "compact_session",
    args.trace,
    (trace) => compactSession({ ...args, trace }),
    (r) =>
      r.compacted
        ? `summarized ${r.summarizedMessageCount} messages`
        : `not compacted (${r.reason})`,
  );
}

async function compactSession(
  args: RunContext & { sessionId: string; keepLastN?: number },
): Promise<CompactResult> {
  const { sessionId, keepLastN = 10, trace } = args;

  const session = await prisma.chatSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { summary: true, summarizedUpToMessageId: true },
  });

  const allMessages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, createdAt: true },
  });

  // If a prior compaction exists, only consider messages after that cutoff.
  let candidates = allMessages;
  if (session.summarizedUpToMessageId) {
    const cutoff = allMessages.find(
      (m) => m.id === session.summarizedUpToMessageId,
    );
    if (cutoff) {
      candidates = allMessages.filter((m) => m.createdAt > cutoff.createdAt);
    }
  }

  if (candidates.length <= keepLastN) {
    return { compacted: false, reason: "too_short" };
  }

  // Naive cutoff: keep the last `keepLastN` messages.
  let cutIdx = candidates.length - keepLastN;
  // Advance the cutoff forward through any non-USER messages so the FIRST kept
  // message is a real Role.USER. This prevents the replay from starting with
  // an orphan tool_result (whose tool_use was summarized away) or a stray
  // assistant turn, either of which the Anthropic API rejects.
  while (cutIdx < candidates.length && candidates[cutIdx].role !== Role.USER) {
    cutIdx++;
  }
  if (cutIdx >= candidates.length) {
    // Nothing left to keep after the boundary search. Bail rather than wipe
    // the entire recent context.
    return { compacted: false, reason: "too_short" };
  }
  const toSummarize = candidates.slice(0, cutIdx);
  const cutoffMessageId = toSummarize[toSummarize.length - 1].id;

  // Surface the start to the chat UI so the user immediately sees what the long
  // pause is; the summary pass then fills in under the same chip.
  traceText(
    trace,
    `Compacting ${toSummarize.length} earlier message${toSummarize.length === 1 ? "" : "s"}…`,
  );

  const summary = await runSubAgent(
    compactSummarySubAgent,
    {
      messages: toSummarize,
      priorSummary: session.summary?.trim() || undefined,
    },
    args,
  );

  // No summary, no truncation: `summarizedUpToMessageId` is the load-bearing
  // "this conversation is truncated past here" pointer, and advancing it
  // without a summary would drop the span with nothing standing in for it.
  if (!summary.ok) {
    console.warn("[compact] summary pass failed:", summary.error);
    return { compacted: false, reason: "summary_failed" };
  }

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      summary: summary.output,
      summarizedUpToMessageId: cutoffMessageId,
      compactedAt: new Date(),
      compactionDeferredCount: 0,
    },
  });

  return { compacted: true, summarizedMessageCount: toSummarize.length };
}
