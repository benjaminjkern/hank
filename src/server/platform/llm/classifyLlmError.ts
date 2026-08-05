// Is this thrown error a key/credit problem the blocking modal can fix?
//
// Two callers need the same answer and must not drift: the chat route turns a
// hit into a typed SSE code so the client pops ApiKeyBlockerModal, and
// runUserMessage skips writing a `run_error` transcript row for it (the modal
// owns that failure; a chat row would double up on it).
//
// The main chat agent runs on DeepSeek (Anthropic survives only as the vision
// carve-out, and a vision failure can NEVER reach a chat catch — runParseResume
// throws convert to is_error tool_results inside the agent loop, and
// logoVerifier is fully swallowed; only the main-agent stream fault propagates).
// So a bare Anthropic.APIError here is a DeepSeek error (same SDK, different
// baseURL):
//   401 → user's saved DeepSeek key was rejected (revoked / typo'd).
//   402, or 400 + balance/insufficient → DeepSeek wallet ran dry.
// (Mirrors validateDeepseekKey's status handling in settings/actions.ts.)
// Anything else returns null so the modal doesn't shadow unrelated failures.
// This holds as long as HANK_MODEL names a DeepSeek model. Point it at a Claude
// one and these codes become a lie — revisit here too.

import Anthropic from "@anthropic-ai/sdk";

export type ClassifiedLlmError =
  | { code: "INVALID_DEEPSEEK_KEY"; message: string }
  | { code: "DEEPSEEK_NO_CREDIT"; message: string };

export function classifyLlmError(err: unknown): ClassifiedLlmError | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  if (err.status === 401) {
    return {
      code: "INVALID_DEEPSEEK_KEY",
      message: "DeepSeek rejected the saved API key.",
    };
  }
  const raw = err.message ?? "";
  if (
    err.status === 402 ||
    (err.status === 400 && /balance|insufficient/i.test(raw))
  ) {
    return {
      code: "DEEPSEEK_NO_CREDIT",
      message: "DeepSeek balance is too low.",
    };
  }
  return null;
}
