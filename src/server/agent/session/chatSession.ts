// ChatSession lifecycle: which session a user's messages land in.
// Split out of the former runtime/session.ts, which had grown to hold three
// separate jobs — session lifecycle (here), transcript replay (loadTranscript.ts),
// and message persistence (appendMessages.ts).

import { prisma } from "@/server/db/prisma";

export async function getOrCreateActiveSession(userId: string) {
  const existing = await prisma.chatSession.findFirst({
    where: { userId, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (existing) return existing;
  return await prisma.chatSession.create({ data: { userId } });
}

export async function endActiveSessions(userId: string) {
  await prisma.chatSession.updateMany({
    where: { userId, endedAt: null },
    data: { endedAt: new Date() },
  });
}

// Model-facing note injected (by loadSessionMessages) into the user turn that
// follows a reply that got cut off — whether the user pressed Stop, the
// connection dropped mid-stream, or the turn errored out (all three persist the
// partial with stoppedByUser=true). Cause-neutral wording on purpose: we can't
// tell which it was from the flag, and the resumable outcome is the same. Keeps
// the resume affordance implicit — no "continue" widget — while making the
