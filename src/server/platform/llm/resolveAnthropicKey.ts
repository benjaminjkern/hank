import { prisma } from "@/server/db/prisma";

import { decryptApiKey } from "./keyCrypto";

// The single resolution point for an Anthropic API key. Every place that
// constructs an Anthropic client funnels through here so the gate stays in
// one spot — a future sub-agent that forgets to plumb userId is a compile
// error, not a silent bypass.
//
// Precedence:
//   1. User's own decrypted key, if set
//   2. process.env.ANTHROPIC_API_KEY, only when canUseServerKey=true
//   3. NoAnthropicKeyError (route handlers translate this into a structured
//      user-visible response)

export class NoAnthropicKeyError extends Error {
  readonly code = "NO_ANTHROPIC_KEY" as const;
  constructor(message = "No Anthropic API key configured for this user") {
    super(message);
    this.name = "NoAnthropicKeyError";
  }
}

// `billedToServer` reports which key paid: false when the user's own decrypted
// key was used, true when we fell back to the server ANTHROPIC_API_KEY. Callers
// thread it into recordUsage so the admin usage page can split our spend from
// users' own-key spend.
type ResolvedAnthropicKey = { key: string; billedToServer: boolean };

export async function resolveAnthropicApiKeyWithSource(
  userId: string,
): Promise<ResolvedAnthropicKey> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      anthropicKeyEncrypted: true,
      canUseServerKey: true,
    },
  });
  if (!user) throw new NoAnthropicKeyError("User not found");

  if (user.anthropicKeyEncrypted) {
    return {
      key: decryptApiKey(user.anthropicKeyEncrypted, {
        userId,
        provider: "anthropic",
      }),
      billedToServer: false,
    };
  }

  if (user.canUseServerKey) {
    const serverKey = process.env.ANTHROPIC_API_KEY;
    if (!serverKey) {
      throw new NoAnthropicKeyError(
        "Server fallback key is enabled for this user, but ANTHROPIC_API_KEY is not set",
      );
    }
    return { key: serverKey, billedToServer: true };
  }

  throw new NoAnthropicKeyError();
}

// Back-compat string form. Callers that only need the key (audit scripts, etc.)
// keep using this; resolveLlmClient uses the WithSource variant to record which
// key paid.
export async function resolveAnthropicApiKey(userId: string): Promise<string> {
  return (await resolveAnthropicApiKeyWithSource(userId)).key;
}
