import { prisma } from "@/server/db/prisma";

import { decryptApiKey } from "./keyCrypto";

// The single resolution point for a DeepSeek API key — the mirror of
// resolveAnthropicKey.ts. Precedence:
//   1. User's own decrypted key (deepseekKeyEncrypted), if set
//   2. process.env.DEEPSEEK_API_KEY, only when canUseServerKey=true
//      (one flag gates BOTH server keys — there is no separate DeepSeek flag)
//   3. NoDeepseekKeyError
// `billedToServer` reports which key paid (false = user's own, true = server
// fallback) so callers can thread it into recordUsage.

export class NoDeepseekKeyError extends Error {
  readonly code = "NO_DEEPSEEK_KEY" as const;
  constructor(message = "No DeepSeek API key configured for this user") {
    super(message);
    this.name = "NoDeepseekKeyError";
  }
}

export async function resolveDeepseekApiKey(
  userId: string,
): Promise<{ key: string; billedToServer: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { deepseekKeyEncrypted: true, canUseServerKey: true },
  });
  if (!user) throw new NoDeepseekKeyError("User not found");
  if (user.deepseekKeyEncrypted)
    return {
      key: decryptApiKey(user.deepseekKeyEncrypted, {
        userId,
        provider: "deepseek",
      }),
      billedToServer: false,
    };
  if (user.canUseServerKey) {
    const serverKey = process.env.DEEPSEEK_API_KEY;
    if (serverKey) return { key: serverKey, billedToServer: true };
    throw new NoDeepseekKeyError(
      "Server fallback is enabled for this user, but DEEPSEEK_API_KEY is not set",
    );
  }
  throw new NoDeepseekKeyError();
}
