// Server-side landing for a browser-reported client event: write the
// ClientEvent row. The row feeds the turn-start `<recent-client-errors>` context
// block (recent.ts) so the agent has the context the user saw in their browser.
//
// Resilience: a telemetry write must NEVER break the user's session. The caller
// (the POST route) is fire-and-forget from the browser's side, and this whole
// function swallows its own errors — including the case where the ClientEvent
// table doesn't exist yet (migration not applied), so the feature is inert, not
// breaking, until the migration lands.

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { deriveClientEventDedupKey, type ClientEventInput } from "./types";

export async function recordClientEvent(
  userId: string,
  // The caller's own active session, resolved server-side by the route — so the
  // turn-start block (which queries ClientEvents by sessionId) can't be poisoned
  // with a foreign sessionId.
  sessionId: string,
  input: ClientEventInput,
): Promise<void> {
  try {
    const context = (input.context ?? null) as Record<string, unknown> | null;
    const dedupKey = deriveClientEventDedupKey(input.source, context);

    await prisma.clientEvent.create({
      data: {
        userId,
        sessionId,
        source: input.source,
        severity: input.severity,
        summary: input.summary,
        context:
          context === null ? undefined : (context as Prisma.InputJsonValue),
        dedupKey,
      },
    });
  } catch {
    // Swallow — telemetry must never surface to the user or break the turn.
  }
}
