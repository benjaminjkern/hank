// Say something in the transcript, from outside an agent turn.
//
// Both helpers do the same two things — yield the event so it streams live, then
// write it as its own assistant ChatMessage row so it survives a refresh. The
// row is what makes them different from a bare `yield`: only the walkthrough
// state machine has an outer buffer that collects its events and persists them
// at the end of a pass (runStateMachineAndPersist), so everything else —
// top-level widget dispatches, the what's-next renderer, the watchlist add —
// would otherwise stream a line that vanishes on reload.
//
// Which one to reach for: `narrateStatus` is deterministic machine narration
// ("Pulling in roles for 3 companies…"), persisted as a `pipeline_status` block
// and re-roled on replay so the model reads it as a system record rather than
// its own prose. `narrateText` is ordinary assistant prose the model SHOULD read
// back as its own ("✓ Added Stripe — 12 open roles."). See uiProvenance.ts for
// why that distinction is load-bearing.

import { Role } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import type { TurnEvent } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";

export async function* narrateStatus(
  sessionId: string,
  text: string,
  runId?: string,
): AsyncGenerator<TurnEvent> {
  yield { type: "pipeline_status", text };
  await prisma.chatMessage.create({
    data: {
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
  yield { type: "text", text };
  await prisma.chatMessage.create({
    data: {
      sessionId,
      role: Role.ASSISTANT,
      content: [{ type: "text", text }],
      runId: runId ?? null,
    },
  });
}
