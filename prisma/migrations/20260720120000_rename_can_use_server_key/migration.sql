-- Rename the server-key permission flag to a provider-neutral name. It gates BOTH
-- server keys (DEEPSEEK_API_KEY + ANTHROPIC_API_KEY), so the Anthropic-specific
-- legacy name was misleading. Pure rename — no data change, no default change.
ALTER TABLE "User" RENAME COLUMN "canUseServerAnthropicKey" TO "canUseServerKey";

-- Drop the dead per-user provider toggle. DeepSeek is now the sole provider (the
-- toggle was removed); nothing has read or written this column since. No backfill
-- needed — the data is meaningless.
ALTER TABLE "User" DROP COLUMN "preferredLlmProvider";
