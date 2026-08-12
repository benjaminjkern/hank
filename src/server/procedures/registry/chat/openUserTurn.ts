// Write the user's message into the transcript — the first thing runChat does,
// before anything that can fail.
//
// WHEN it runs is the whole point, which is why it's a function of its own
// rather than a line inside whichever branch handles the message. A failed run
// reaches the client as an `error` plus a terminal `done`, and that `done`
// makes the client reconcile from the DB — so a message not yet written is a
// message the failure deletes off the user's screen, leaving them looking at an
// error row for something they can no longer see they said.
//
// It also answers the routing question the caller needs and nothing else can:
// whether this send opened a turn at all. An empty composer is a real message
// when the user's panel marks ARE the message, and no message at all otherwise.

import { appendUserMessage } from "@/server/agent/session";
import { buildPanelEditBlocks } from "@/server/widgets/panelEditRelay";

import type { ChatArgs } from "./runChat";
import type Anthropic from "@anthropic-ai/sdk";

export type OpenedUserTurn = {
  // A user row was written for this message.
  opened: boolean;
  // Panel marks rode in it. With an empty composer that's what makes the send a
  // turn to answer rather than a "nothing to run on".
  carriedPanelEdits: boolean;
};

export async function openUserTurn(args: ChatArgs): Promise<OpenedUserTurn> {
  const leadingBlocks = await panelEditBlocks(args.userId);
  if (
    !args.userMessage &&
    args.attachmentIds.length === 0 &&
    leadingBlocks.length === 0
  ) {
    return { opened: false, carriedPanelEdits: false };
  }
  await appendUserMessage(
    args.sessionId,
    args.userMessage,
    args.attachmentIds,
    { runId: args.runId, leadingBlocks },
  );
  return { opened: true, carriedPanelEdits: leadingBlocks.length > 0 };
}

// The relay is best-effort BECAUSE it runs here. Everything else in this
// function exists to get the user's words persisted, so a failure reading their
// panel marks must not be able to take the words down with it — and it costs
// nothing to degrade, since divergence from the settled state is what marks an
// edit unrelayed, so unread marks simply ride the next message instead.
async function panelEditBlocks(
  userId: string,
): Promise<Anthropic.ContentBlockParam[]> {
  try {
    return await buildPanelEditBlocks(userId);
  } catch (err) {
    console.error("panel-edit relay failed; marks ride the next message:", err);
    return [];
  }
}
