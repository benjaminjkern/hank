// Run-tree capture glue for the four flow runners (admin /admin/runs).
//
// Each runner assembles its system prompt with buildHankSystem and calls
// runAgentTurn. This helper (a) dedupes the static prompt skeleton into
// PromptSnapshot and (b) returns the recordUsage fields that carry the model
// params + the volatile prompt pieces — so the inspector can reconstruct the
// exact request (skeleton + volatile) and see the params the turn actually used.

import type { Prisma } from "@/generated/prisma/client";
import type { HankSystemPrompt } from "@/server/agent/hank";
import type { AgentTurnResult } from "@/server/agent/runtime/runAgentTurn";
import { upsertPromptSnapshot } from "@/server/platform/usage/promptSnapshot";

export async function captureTurn(
  flow: string,
  sys: HankSystemPrompt,
  turn: AgentTurnResult,
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
