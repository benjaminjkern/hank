import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM envelope encryption for user-supplied provider API keys —
// provider-neutral: the SAME encrypt/decrypt/hint is used for BOTH the
// Anthropic key (User.anthropicKeyEncrypted, via resolveAnthropicKey.ts) and
// the DeepSeek key (User.deepseekKeyEncrypted, via resolveDeepseekKey.ts).
//
// Master key comes from ANTHROPIC_KEY_ENCRYPTION_KEY (base64-encoded 32 bytes;
// generate with `openssl rand -base64 32`). The env var name is Anthropic-era
// legacy — kept as-is deliberately (it's a prod secret; renaming it buys nothing
// and would force an env rotation). It encrypts every provider's key regardless.
// Every encryption uses a fresh random 12-byte IV; the GCM auth tag is stored
// alongside so decryption fails loudly if the ciphertext is tampered with.
//
// ONE storage format. Anything else in the column is a bug, not an older row:
//
//   "v1." + base64( iv (12) || authTag (16) || ciphertext )
//   AAD = "<userId>:<provider>"
//
// The AAD binds each ciphertext to exactly one (user, provider) cell, so a blob
// copied into another user's row — or into the same user's other provider
// column — fails authentication instead of silently billing the wrong account.
//
// The version tag is a STRING prefix rather than a byte inside the envelope
// because "." is not in the base64 alphabet: `startsWith("v1.")` can never
// misfire, whereas a leading version byte is indistinguishable from a random IV
// byte one time in 256. It also makes a format audit a plain SQL predicate —
// `WHERE "anthropicKeyEncrypted" NOT LIKE 'v1.%'` should always return 0 rows.
// A v2 (e.g. KMS-wrapped DEKs) migrates the same way v1 did: convert every row
// with a one-shot script, THEN ship the reader — so this file only ever knows
// about the current format and never accumulates compatibility branches.
//
// This module is the single swap point if we ever move to KMS-backed envelope
// encryption — the encrypt/decrypt signatures stay the same.

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const V1_PREFIX = "v1.";

// Which cell a ciphertext is allowed to live in. Both fields go into the AAD,
// so both must match at decrypt time.
export type KeyBinding = {
  userId: string;
  provider: "anthropic" | "deepseek";
};

function aad(binding: KeyBinding): Buffer {
  return Buffer.from(`${binding.userId}:${binding.provider}`, "utf8");
}

function getMasterKey(): Buffer {
  const raw = process.env.ANTHROPIC_KEY_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ANTHROPIC_KEY_ENCRYPTION_KEY is not set — cannot encrypt/decrypt user API keys",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `ANTHROPIC_KEY_ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}`,
    );
  }
  return buf;
}

export function encryptApiKey(plaintext: string, binding: KeyBinding): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(aad(binding));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return V1_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptApiKey(blob: string, binding: KeyBinding): string {
  const key = getMasterKey();
  // Shape checks, not a compatibility path — every stored row was converted to
  // v1 before this reader shipped. An untagged blob now means a hand-edited row
  // or a restore from a pre-v1 backup, so say what to do about it.
  if (!blob.startsWith(V1_PREFIX)) {
    throw new Error(
      `Stored ${binding.provider} key for user ${binding.userId} is not in the v1 format — likely a hand-written row or a pre-v1 backup restore. Re-save the key in /settings.`,
    );
  }
  const buf = Buffer.from(blob.slice(V1_PREFIX.length), "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("ciphertext blob too short to be valid");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(aad(binding));
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // Node's GCM failure ("unable to authenticate data") names no cause; say
    // what the causes actually are. Never include the plaintext or the blob.
    throw new Error(
      `Failed to decrypt the ${binding.provider} key for user ${binding.userId} — wrong ANTHROPIC_KEY_ENCRYPTION_KEY, a corrupted row, or a ciphertext that belongs to a different user/provider`,
    );
  }
}

export function keyHint(apiKey: string): string {
  return apiKey.slice(-4);
}
