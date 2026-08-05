import { createCipheriv, randomBytes } from "node:crypto";

import {
  decryptApiKey,
  encryptApiKey,
} from "../../src/server/platform/llm/keyCrypto";

// Synthetic regression for the stored-key format in
// src/server/platform/llm/keyCrypto.ts: the v1 envelope round-trips, its
// (userId, provider) binding is actually enforced, and anything that isn't v1
// is refused rather than silently mis-read.
//
// Touches NO database and NOT the real master key — it generates a throwaway
// ANTHROPIC_KEY_ENCRYPTION_KEY for the run, so it costs nothing and is safe to
// run anywhere. Re-run it after any change to keyCrypto.ts.
//
//   pnpm tsx scripts/regression/key-crypto.ts

process.env.ANTHROPIC_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");

// The pre-v1 envelope (no version tag, no AAD). Kept only to prove the reader
// REFUSES it — no stored row uses this format any more.
function preV1Encrypt(plaintext: string): string {
  const key = Buffer.from(process.env.ANTHROPIC_KEY_ENCRYPTION_KEY!, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

const KEY = "sk-ant-api03-notarealkeyAAAAAAAAAAAAAAAAAAAAAAAA1234";
const userA = { userId: "cuid_user_a", provider: "anthropic" } as const;
const userB = { userId: "cuid_user_b", provider: "anthropic" } as const;

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
  if (!ok) failures++;
}
function rejects(fn: () => unknown, expect?: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return expect ? expect.test(err instanceof Error ? err.message : "") : true;
  }
}

console.log("A stored key round-trips in its own cell:");
const blob = encryptApiKey(KEY, userA);
check("carries the v1. version tag", blob.startsWith("v1."));
check("decrypts under its own binding", decryptApiKey(blob, userA) === KEY);
check(
  "two encryptions of the same key differ (fresh IV)",
  encryptApiKey(KEY, userA) !== blob,
);

console.log("\nThe binding is load-bearing, not decorative:");
check(
  "rejects another user's binding",
  rejects(() => decryptApiKey(blob, userB)),
);
check(
  "rejects the other provider column",
  rejects(() =>
    decryptApiKey(blob, { userId: userA.userId, provider: "deepseek" }),
  ),
);
check(
  "rejects a tampered ciphertext",
  rejects(() => decryptApiKey(`${blob.slice(0, -6)}AAAAA=`, userA)),
);

console.log("\nAnything that isn't v1 is refused, with a fixable message:");
check(
  "a pre-v1 blob is refused (all rows were migrated before this shipped)",
  rejects(
    () => decryptApiKey(preV1Encrypt(KEY), userA),
    /not in the v1 format/,
  ),
);
check(
  "an empty column value is refused",
  rejects(() => decryptApiKey("", userA), /not in the v1 format/),
);
check(
  "a truncated v1 blob is refused",
  rejects(() => decryptApiKey("v1.AAAA", userA), /too short/),
);

console.log("\nThe v1. tag is unambiguous over many pre-v1 blobs:");
let misread = 0;
for (let i = 0; i < 20000; i++) {
  if (preV1Encrypt(KEY).startsWith("v1.")) misread++;
}
check(`0 of 20000 pre-v1 blobs look like v1 (got ${misread})`, misread === 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
