-- When a user asked an admin for server-key access from the blocked-chat modal.
-- NULL = never asked. Re-requesting overwrites, so the column doubles as "how
-- long has this person been waiting" on /admin/users.
ALTER TABLE "User" ADD COLUMN "accessRequestedAt" TIMESTAMP(3);

-- Partial index: the admin list only ever filters for outstanding requests.
CREATE INDEX "User_accessRequestedAt_idx"
  ON "User" ("accessRequestedAt")
  WHERE "accessRequestedAt" IS NOT NULL;
