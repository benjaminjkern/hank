-- Add bill-source tracking to TokenUsage.
-- true  = our server key paid (resolveLlmClient fell back to ANTHROPIC_API_KEY / DEEPSEEK_API_KEY)
-- false = the user's own decrypted key paid
-- New rows set this explicitly from the key the resolver used; default true is the
-- common case (most users currently have no own key and run on the server fallback).
ALTER TABLE "TokenUsage" ADD COLUMN "billedToServer" boolean NOT NULL DEFAULT true;

-- Legacy backfill (approximate): we never recorded which key paid for historical
-- rows, so infer it from each user's CURRENT key state. A row is treated as
-- user-billed only if that user has an own key for the row's provider now. The
-- provider is read off the model id (deepseek* vs the Anthropic tiers). Everything
-- else keeps the default true (server-billed). This is best-effort: a user who
-- added/removed a key since the call may be mislabeled on old rows — going forward
-- the flag is exact.
UPDATE "TokenUsage" tu
SET "billedToServer" = false
FROM "User" u
WHERE tu."userId" = u.id
  AND tu.model LIKE 'deepseek%'
  AND u."deepseekKeyEncrypted" IS NOT NULL;

UPDATE "TokenUsage" tu
SET "billedToServer" = false
FROM "User" u
WHERE tu."userId" = u.id
  AND tu.model NOT LIKE 'deepseek%'
  AND u."anthropicKeyEncrypted" IS NOT NULL;
