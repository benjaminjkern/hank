// Turn-start context: render the `<recent-client-errors>` block for the agent
// system prompt. Surfaces browser-side events the user saw since
// Hank last replied, so the agent has the context the user has.
//
// This runs on EVERY chat turn (wired into each pipeline runner), so it must
// NEVER throw — a missing table (migration not applied) or any query error
// degrades to "" (no block injected), not a broken turn.

import { Role } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { relativeTime } from "@/utils/date";
import { nowMs } from "@/utils/now";

const MAX_EVENTS = 10;
// If the session has no assistant reply yet, only look back a short window so a
// stale event can't haunt a brand-new conversation forever.
const NO_ASSISTANT_LOOKBACK_MS = 30 * 60 * 1000;

export async function loadRecentClientErrors(
  sessionId: string,
): Promise<string> {
  try {
    // Cutoff = the last assistant reply. Events after it are things the user saw
    // since Hank last spoke — naturally self-clearing (once Hank replies, they
    // predate the new last-assistant message and won't surface again).
    const lastAssistant = await prisma.chatMessage.findFirst({
      where: { sessionId, role: Role.ASSISTANT },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const cutoff =
      lastAssistant?.createdAt ?? new Date(nowMs() - NO_ASSISTANT_LOOKBACK_MS);

    const events = await prisma.clientEvent.findMany({
      where: { sessionId, createdAt: { gt: cutoff } },
      orderBy: { createdAt: "desc" },
      take: MAX_EVENTS,
      select: { createdAt: true, summary: true },
    });
    if (events.length === 0) return "";
    // Oldest-first reads naturally in the block.
    return renderBlock(events.reverse());
  } catch {
    return "";
  }
}

function renderBlock(events: { createdAt: Date; summary: string }[]): string {
  // Collapse consecutive identical summaries into "… (×N)" so a flaky
  // connection firing the same event repeatedly doesn't bury the block.
  const collapsed: { time: Date; summary: string; count: number }[] = [];
  for (const e of events) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.summary === e.summary) {
      last.count += 1;
      last.time = e.createdAt;
    } else {
      collapsed.push({ time: e.createdAt, summary: e.summary, count: 1 });
    }
  }
  const lines = collapsed.map(
    (c) =>
      `- ${relativeTime(c.time)} — ${c.summary}${c.count > 1 ? ` (×${c.count})` : ""}`,
  );
  return [
    "<recent-client-errors>",
    "Things that happened in the user's browser since your last reply — they saw these, you didn't (they're not in the transcript above). Use your own judgment about whether and how to address them: a dropped connection might mean your last message never reached them and is worth a quick re-check; a deliberate Stop usually needs nothing. Never mention these tags or any internal/technical terms — just talk to the user naturally.",
    ...lines,
    "</recent-client-errors>",
  ].join("\n");
}
