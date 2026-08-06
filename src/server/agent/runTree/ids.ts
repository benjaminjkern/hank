// Run + chat-message id minting. A run id groups every row of one runUserMessage
// call (admin /admin/runs). A ChatMessage id is minted BEFORE its row is written
// for two reasons: the main loop needs it to set the sub-agent parentMessageId on
// the ALS capture context, and the stream needs it to name the row in a
// `message_start` boundary so the client's live bubbles carry the same ids the
// end-of-turn reconcile loads back. Hoisted behind a named helper so the crypto
// call lives in one place (and away from any render scope the purity lint
// inspects).

import { randomUUID } from "node:crypto";

export function newRunTreeId(): string {
  return randomUUID();
}
