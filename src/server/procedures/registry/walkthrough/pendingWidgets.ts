// "Is a widget we already put on screen still unanswered?" — the chat-history
// walker the discovery arm consults before re-running its search: a cache
// lookup that re-shows a pending checklist instead of re-running an LLM call.
//
// Walks recent messages newest-first, and treats an ASSISTANT `pipeline_widget`
// block with no later USER submission marker as still pending. Scan depth is
// bounded so a long session doesn't drag a state-machine pass; anything older
// than the window the user has effectively forgotten about anyway.

import { extractWidgetMarker } from "@/lib/widgetMarker";
import { prisma } from "@/server/db/prisma";

type HistoryBlock = {
  type?: string;
  kind?: string;
  payload?: { companyId?: string; suggestions?: unknown };
  text?: string;
};

async function recentBlocks(
  sessionId: string,
  take: number,
): Promise<Array<{ role: string; blocks: HistoryBlock[] }>> {
  const recent = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take,
    select: { role: true, content: true },
  });
  return recent.flatMap((m) => {
    const blocks = m.content as HistoryBlock[];
    return Array.isArray(blocks) ? [{ role: m.role, blocks }] : [];
  });
}

// The widget-response marker on a USER block, if it carries one.
function submissionMarker(
  block: HistoryBlock,
): { kind?: string; companyId?: string } | null {
  if (block.type !== "text" || typeof block.text !== "string") return null;
  return extractWidgetMarker(block.text);
}

// The payload of a company_checklist that's on screen and still unanswered, or
// null. Unlike the two guards above, a miss here just means "search again"
// rather than a bug — the discovery arm uses it as a cache lookup.
export async function loadPendingChecklist(
  sessionId: string,
): Promise<{ suggestions: unknown } | null> {
  for (const m of await recentBlocks(sessionId, 20)) {
    if (m.role === "USER") {
      for (const block of m.blocks) {
        // Answered (or explicitly declined) — nothing pending.
        if (submissionMarker(block)?.kind === "company_checklist") return null;
      }
    } else if (m.role === "ASSISTANT") {
      for (const block of m.blocks) {
        if (
          block.type === "pipeline_widget" &&
          block.kind === "company_checklist" &&
          block.payload?.suggestions
        ) {
          return { suggestions: block.payload.suggestions };
        }
      }
    }
  }
  return null;
}
