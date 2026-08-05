// Run-tree id minting (admin /admin/runs). A run id groups every row of one
// runUserMessage call; a pre-minted assistant message id lets the main loop set
// the sub-agent parentMessageId on the ALS capture context BEFORE the assistant
// ChatMessage row is written. Hoisted behind named helpers so the crypto call
// lives in one place (and away from any render scope the purity lint inspects).

import { randomUUID } from "node:crypto";

export function newRunTreeId(): string {
  return randomUUID();
}
