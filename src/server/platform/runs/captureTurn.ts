// Run-tree capture glue for the four flow runners (admin /admin/runs).
//
// Each runner assembles its system prompt with buildHankSystem and calls
// runAgentTurn. This helper (a) dedupes the static prompt skeleton into
// PromptSnapshot and (b) returns the recordUsage fields that carry the model
// params + the volatile prompt pieces — so the inspector can reconstruct the
// exact request (skeleton + volatile) and see the params the turn actually used.

import type { Prisma } from "@/server/generated/prisma/client";
import { upsertPromptSnapshot } from "@/server/platform/runs/promptSnapshot";

// The prompt as the inspector stores it: the static skeleton once per hash, and
// the per-turn pieces on the row.
export type CapturedPrompt = {
  staticHash: string;
  staticText: string;
  volatile: unknown;
};

export async function captureTurn(
  flow: string,
  sys: CapturedPrompt,
  turn: { requestParams: Record<string, unknown> },
): Promise<{
  systemPromptHash: string;
  requestParams: Prisma.InputJsonValue;
}> {
  // Fire-and-forget dedup; first writer wins, never throws.
  await upsertPromptSnapshot({
    hash: sys.staticHash,
    flow,
    text: sys.staticText,
  });
  return {
    systemPromptHash: sys.staticHash,
    requestParams: {
      ...turn.requestParams,
      systemPrompt: { hash: sys.staticHash, volatile: sys.volatile },
    } as unknown as Prisma.InputJsonValue,
  };
}
