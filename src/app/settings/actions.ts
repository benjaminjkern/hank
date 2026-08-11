"use server";

import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/server/auth/currentUser";
import { prisma } from "@/server/db/prisma";
import { allowUserApiKeys } from "@/server/platform/deployment";
import { DEEPSEEK_ANTHROPIC_BASE_URL } from "@/server/platform/llm/deepseek";
import { encryptApiKey, keyHint } from "@/server/platform/llm/keyCrypto";
import type { LlmModel } from "@/server/platform/llm/models";

// The cheapest DeepSeek model — this is a one-token auth ping, not real work.
const DEEPSEEK_VALIDATION_MODEL: LlmModel = "deepseek-v4-flash";

export type SaveApiKeyResult = { ok: true } | { ok: false; error: string };

// Both save paths check this first. The settings UI and the blocker modal
// already hide their paste forms when the instance disallows own keys, but a
// hidden form is not a check — an instance that means "server key only" has to
// refuse the write, not just decline to offer it.
const BYOK_DISABLED_MESSAGE =
  "This instance doesn't accept personal API keys. Ask an admin for access instead.";

// Validates the user-submitted Anthropic API key with a one-token ping before
// storing it. Catches typos at save time rather than letting them surface on
// first chat attempt. Never includes the submitted key in the error message —
// validation failures only carry the SDK's own status/code.
async function validateAnthropicKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client = new Anthropic({ apiKey });
  try {
    await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      if (err.status === 401) {
        return { ok: false, reason: "Key did not authenticate (401)." };
      }
      if (err.status === 400 && /credit balance/i.test(err.message ?? "")) {
        return {
          ok: false,
          reason:
            "Key is valid but the Anthropic credit balance is too low. Top up at console.anthropic.com.",
        };
      }
      return { ok: false, reason: `Validation failed (${err.status ?? "?"}).` };
    }
    return {
      ok: false,
      reason: "Validation failed — could not reach Anthropic.",
    };
  }
}

export async function saveApiKey(
  formData: FormData,
): Promise<SaveApiKeyResult> {
  if (!allowUserApiKeys) return { ok: false, error: BYOK_DISABLED_MESSAGE };
  const user = await getCurrentUser();
  const raw = formData.get("apiKey");
  const apiKey = typeof raw === "string" ? raw.trim() : "";
  if (!apiKey)
    return { ok: false, error: "Paste your Anthropic API key first." };

  const validation = await validateAnthropicKey(apiKey);
  if (!validation.ok) return { ok: false, error: validation.reason };

  await prisma.user.update({
    where: { id: user.id },
    data: {
      anthropicKeyEncrypted: encryptApiKey(apiKey, {
        userId: user.id,
        provider: "anthropic",
      }),
      anthropicKeyHint: keyHint(apiKey),
      anthropicKeyUpdatedAt: new Date(),
    },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function clearApiKey(): Promise<void> {
  const user = await getCurrentUser();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      anthropicKeyEncrypted: null,
      anthropicKeyHint: null,
      anthropicKeyUpdatedAt: null,
    },
  });
  revalidatePath("/settings");
}

// --- DeepSeek (Anthropic-compatible endpoint) ---------------------------

// Validates a DeepSeek key by pinging the cheapest model (v4-flash) through the
// same Anthropic-compatible endpoint the runtime uses, so a save-time success
// guarantees the runtime auth path works. Never echoes the key.
async function validateDeepseekKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client = new Anthropic({
    apiKey,
    baseURL: DEEPSEEK_ANTHROPIC_BASE_URL,
  });
  try {
    await client.messages.create({
      model: DEEPSEEK_VALIDATION_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      if (err.status === 401) {
        return { ok: false, reason: "Key did not authenticate (401)." };
      }
      if (
        err.status === 402 ||
        (err.status === 400 && /balance|insufficient/i.test(err.message ?? ""))
      ) {
        return {
          ok: false,
          reason:
            "Key is valid but the DeepSeek balance is too low. Top up at platform.deepseek.com.",
        };
      }
      return { ok: false, reason: `Validation failed (${err.status ?? "?"}).` };
    }
    return {
      ok: false,
      reason: "Validation failed — could not reach DeepSeek.",
    };
  }
}

export async function saveDeepseekKey(
  formData: FormData,
): Promise<SaveApiKeyResult> {
  if (!allowUserApiKeys) return { ok: false, error: BYOK_DISABLED_MESSAGE };
  const user = await getCurrentUser();
  const raw = formData.get("apiKey");
  const apiKey = typeof raw === "string" ? raw.trim() : "";
  if (!apiKey)
    return { ok: false, error: "Paste your DeepSeek API key first." };

  const validation = await validateDeepseekKey(apiKey);
  if (!validation.ok) return { ok: false, error: validation.reason };

  await prisma.user.update({
    where: { id: user.id },
    data: {
      deepseekKeyEncrypted: encryptApiKey(apiKey, {
        userId: user.id,
        provider: "deepseek",
      }),
      deepseekKeyHint: keyHint(apiKey),
      deepseekKeyUpdatedAt: new Date(),
    },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function clearDeepseekKey(): Promise<void> {
  const user = await getCurrentUser();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      deepseekKeyEncrypted: null,
      deepseekKeyHint: null,
      deepseekKeyUpdatedAt: null,
    },
  });
  revalidatePath("/settings");
}
