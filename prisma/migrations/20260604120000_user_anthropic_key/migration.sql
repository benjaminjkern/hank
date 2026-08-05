ALTER TABLE "User"
  ADD COLUMN "canUseServerAnthropicKey" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "anthropicKeyEncrypted" TEXT,
  ADD COLUMN "anthropicKeyHint" TEXT,
  ADD COLUMN "anthropicKeyUpdatedAt" TIMESTAMP(3);
