// Per-persona isolation: mint an ephemeral User + ChatSession on the (shared,
// PROD) database. The user gets canUseServerKey=true so Hank's
// internal pipeline calls resolve the server ANTHROPIC_API_KEY (see
// resolveAnthropicApiKey). Everything is tagged with the runId so teardown —
// and a crash-recovery `--cleanup` — can find it.

import { prisma } from "@/server/db/prisma";

import { tagEmail, tagName, tagSessionSummary } from "../lib/tags";

export type PersonaSandbox = {
  userId: string;
  sessionId: string;
  runId: string;
  personaId: string;
};

export async function createPersonaSandbox(
  runId: string,
  personaId: string,
): Promise<PersonaSandbox> {
  const user = await prisma.user.create({
    data: {
      email: tagEmail(runId, personaId),
      name: tagName(runId, personaId),
      // So Hank's in-process pipeline calls fall back to the server key.
      canUseServerKey: true,
    },
    select: { id: true },
  });

  const session = await prisma.chatSession.create({
    data: {
      userId: user.id,
      summary: tagSessionSummary(runId, personaId),
    },
    select: { id: true },
  });

  return { userId: user.id, sessionId: session.id, runId, personaId };
}
