import Anthropic from "@anthropic-ai/sdk";

import { createDeepseekClient } from "./deepseek";
import { MODELS, type LlmModel } from "./models";
import {
  resolveAnthropicApiKeyWithSource,
  NoAnthropicKeyError,
} from "./resolveAnthropicKey";
import {
  resolveDeepseekApiKey,
  NoDeepseekKeyError,
} from "./resolveDeepseekKey";

// Single factory for the LLM client every runtime call site uses. It answers
// exactly one question — which key pays for the model you named — and hands
// back a client wired to that model's provider.
//
// It does NOT choose the model. The call site declares that (a sub-agent's own
// `MODEL` const, HANK_MODEL for the main agent) and the choice is honored
// verbatim: no per-provider fork, no operation→model lookup, no env override
// swapping it out underneath. Provider follows from the model id via MODELS.

export type ResolvedLlm = {
  client: Anthropic;
  // The model to pass to messages.create AND to recordUsage — the same id the
  // call site named, so cost tracking attributes to what actually ran.
  model: LlmModel;
  // Which key paid: true = our server key (DEEPSEEK_API_KEY / ANTHROPIC_API_KEY
  // fallback), false = the user's own decrypted key. Pass to recordUsage so the
  // admin usage page can separate our spend from users' own-key spend.
  billedToServer: boolean;
};

export async function resolveLlmClient(
  userId: string,
  { model }: { model: LlmModel },
): Promise<ResolvedLlm> {
  if (MODELS[model] === "deepseek") {
    const { key: apiKey, billedToServer } = await resolveDeepseekApiKey(userId);
    return { client: createDeepseekClient(apiKey), model, billedToServer };
  }

  const { key: apiKey, billedToServer } =
    await resolveAnthropicApiKeyWithSource(userId);
  return { client: new Anthropic({ apiKey }), model, billedToServer };
}

export { NoAnthropicKeyError, NoDeepseekKeyError };
