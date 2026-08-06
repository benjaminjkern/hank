// Say something in the transcript, from outside an agent turn.
//
// Both helpers do the same three things — open the row (message_start), yield the
// content so it streams live, then write it as its own assistant ChatMessage row
// so it survives a refresh. The row is what makes them different from a bare
// `yield`: only the walkthrough state machine has an outer buffer that collects
// its events and persists them at the end of a pass (runStateMachineAndPersist),
// so everything else — top-level widget dispatches, the what's-next renderer, the
// watchlist add — would otherwise stream a line that vanishes on reload.
//
// The id is minted here rather than left to the database default so the boundary
// event can name it BEFORE the row exists: the client opens a bubble under that
// id, and the end-of-turn reconcile loads the same id back, so the line doesn't
// jump into a different bubble the moment the run ends.
//
// Which one to reach for: `narrateStatus` is deterministic machine narration
// ("Pulling in roles for 3 companies…"), persisted as a `pipeline_status` block
// and re-roled on replay so the model reads it as a system record rather than
// its own prose. `narrateText` is ordinary assistant prose the model SHOULD read
// back as its own ("✓ Added Stripe — 12 open roles."). See uiProvenance.ts for
// why that distinction is load-bearing.

import { Role } from "@/generated/prisma/client";
import type { TurnEvent } from "@/server/agent/contracts";
import { newRunTreeId } from "@/server/agent/runTree/ids";
import { prisma } from "@/server/db/prisma";

export async function* narrateStatus(
  sessionId: string,
  text: string,
  runId?: string,
): AsyncGenerator<TurnEvent> {
  const messageId = newRunTreeId();
  yield { type: "message_start", messageId };
  yield { type: "pipeline_status", text };
  await prisma.chatMessage.create({
    data: {
      id: messageId,
      sessionId,
      role: Role.ASSISTANT,
      content: [{ type: "pipeline_status", text }],
      runId: runId ?? null,
    },
  });
}

export async function* narrateText(
  sessionId: string,
  text: string,
  runId?: string,
): AsyncGenerator<TurnEvent> {
  const messageId = newRunTreeId();
  yield { type: "message_start", messageId };
  yield { type: "text", text };
  await prisma.chatMessage.create({
    data: {
      id: messageId,
      sessionId,
      role: Role.ASSISTANT,
      content: [{ type: "text", text }],
      runId: runId ?? null,
    },
  });
}
