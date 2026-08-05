// What the user did on the right panel between their last message and this one,
// packaged to ride at the head of the new user turn — like an attachment: a chip
// for the user, pre-rendered prose for the model.
//
// It lives here rather than inside `appendUserMessage` because the transcript
// store must not know what a shortlist board is; it lives here rather than in
// either caller because BOTH paths that open a turn have to carry it.
//
// Relaying is also what SETTLES an edit. On the board a marked row sits pending
// under its old group until this runs, then re-files; on an application the
// baseline Hank is diffed against catches up to what's on screen. The two halves
// are one step on purpose — reporting an edit and letting it settle are the same
// event ("a new chat pass happened"), so they can't drift apart.
//
// Derived server-side, never sent by the client, so a queued or re-sent message
// can't drop them. Build BEFORE the new user row is written. A path that forgets
// to call this doesn't LOSE the edits — divergence from the settled state is
// what marks them unrelayed, so they simply ride the next message instead.

import {
  listUnrelayedApplicationEdits,
  renderApplicationEditRelayText,
  settleRelayedApplicationEdits,
} from "@/server/entities/jobs/applicationDrafts";
import {
  listUnrelayedBoardEdits,
  renderBoardEditRelayText,
  settleRelayedBoardEdits,
} from "@/server/entities/jobs/boardStance";

import type Anthropic from "@anthropic-ai/sdk";

const CHIP_WORD: Record<"wrote" | "revised" | "cleared", string> = {
  wrote: "written",
  revised: "edited",
  cleared: "cleared",
};

export async function buildPanelEditBlocks(
  userId: string,
): Promise<Anthropic.ContentBlockParam[]> {
  const [boardEdits, applicationEdits] = await Promise.all([
    listUnrelayedBoardEdits(userId),
    listUnrelayedApplicationEdits(userId),
  ]);

  const blocks: Anthropic.ContentBlockParam[] = [];

  if (boardEdits.length > 0) {
    await settleRelayedBoardEdits(userId, boardEdits);
    blocks.push({
      type: "panel_edits",
      text: renderBoardEditRelayText(boardEdits),
      edits: boardEdits,
    } as unknown as Anthropic.ContentBlockParam);
  }

  if (applicationEdits.length > 0) {
    await settleRelayedApplicationEdits(userId, applicationEdits);
    blocks.push({
      type: "panel_edits",
      text: renderApplicationEditRelayText(applicationEdits),
      // One chip per changed item, in the same {title, companyName, verdict}
      // shape the board's chips use. The rendered prose above is what the model
      // reads; the raw diff segments would bloat every persisted user row for a
      // chip that only needs a label.
      edits: applicationEdits.flatMap((r) =>
        r.edits.map((e) => ({
          title: e.label,
          companyName: r.companyName,
          verdict: CHIP_WORD[e.change],
        })),
      ),
    } as unknown as Anthropic.ContentBlockParam);
  }

  return blocks;
}
