-- Stored provider API keys → the AAD-bound, version-tagged `v1.` ciphertext
-- (src/server/platform/llm/keyCrypto.ts).
--
-- THE WORK IS NOT HERE, AND CAN'T BE. The conversion decrypts AES-256-GCM with
-- the master key from the environment and re-wraps it bound to (userId,
-- provider); Postgres can't do that at all — pgcrypto has no GCM mode — and
-- Prisma has no script-based migration (the engine executes migration.sql and
-- nothing else). So the transform lives in
--
--     scripts/migrations/2026-07-27-keys-to-v1.ts --apply
--
-- and this migration is the ASSERTION that it ran, so the one chain still tells
-- the truth about what has been applied. Pattern for any future JS-only
-- conversion: script does the work, a paired migration checks the result.
--
-- If this fails: run the script above, then `pnpm db:migrate` again. Prisma
-- marks a failed migration as such, so the retry needs one command first:
--
--     pnpm exec prisma migrate resolve --rolled-back 20260727130000_keys_to_v1

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE ("anthropicKeyEncrypted" IS NOT NULL AND "anthropicKeyEncrypted" NOT LIKE 'v1.%')
       OR ("deepseekKeyEncrypted"  IS NOT NULL AND "deepseekKeyEncrypted"  NOT LIKE 'v1.%')
  ) THEN
    RAISE EXCEPTION
      'Stored API keys are still in the pre-v1 format. Run `pnpm tsx scripts/migrations/2026-07-27-keys-to-v1.ts --apply` first, then `pnpm exec prisma migrate resolve --rolled-back 20260727130000_keys_to_v1` and re-run `pnpm db:migrate`.';
  END IF;
END $$;
