-- Per-user LLM provider selection + DeepSeek credential.
-- preferredLlmProvider governs which provider a user's runtime calls hit
-- ("anthropic" default | "deepseek"); the deepseek* columns mirror the
-- anthropic* key columns (AES-256-GCM blob + last-4 hint + updated-at).
ALTER TABLE "User" ADD COLUMN "preferredLlmProvider" TEXT NOT NULL DEFAULT 'anthropic';
ALTER TABLE "User" ADD COLUMN "deepseekKeyEncrypted" TEXT;
ALTER TABLE "User" ADD COLUMN "deepseekKeyHint" TEXT;
ALTER TABLE "User" ADD COLUMN "deepseekKeyUpdatedAt" TIMESTAMP(3);
