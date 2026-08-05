// Per-turn context for open shortlist negotiations: the compact board(s), so
// Hank negotiates from the stances + reasons without re-reading anything. Depth
// stays pull — role summaries and closed tiers are behind read tools
// (show_shortlist_board, read_job_description), not in every prompt.

import { listOpenShortlistBoards } from "@/server/entities/jobs/shortlistPool";
import {
  loadShortlistBoard,
  renderShortlistBoardText,
} from "@/server/views/shortlistBoard";

// Most recently touched first; anything beyond this renders as a one-line
// pointer. More than one open negotiation is already unusual.
const MAX_BOARDS_IN_CONTEXT = 2;

export async function loadHankShortlistBoardContext(
  userId: string,
): Promise<string | undefined> {
  const open = await listOpenShortlistBoards(userId);
  if (open.length === 0) return undefined;
  const shown = open.slice(0, MAX_BOARDS_IN_CONTEXT);
  const boards = await Promise.all(
    shown.map((o) => loadShortlistBoard(userId, o.companyId)),
  );
  const sections = boards
    .filter((b) => b !== null)
    .map((b) => renderShortlistBoardText(b));
  if (sections.length === 0) return undefined;
  if (open.length > shown.length) {
    sections.push(
      `(${open.length - shown.length} more compan${open.length - shown.length === 1 ? "y has" : "ies have"} an open board — show_shortlist_board reads any of them.)`,
    );
  }
  return sections.join("\n\n");
}
