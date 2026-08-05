-- Extend AdminNote with severity, dedup, and last-seen tracking so the new
-- diligence push (tool_misbehavior + self_improvement categories, sub-agent
-- universal flagging, tool-side expectations) doesn't spam the admin page
-- with duplicate rows.
--
-- severity: LOW / MEDIUM / HIGH — agent picks at write time. Default MEDIUM
-- so existing rows aren't biased low/high. Stored as TEXT for the same reason
-- category is TEXT (additive tweaks don't need a migration).
-- dedupKey: optional convention `<source>:<failure mode>:<input shape>`.
-- When a write matches (userId, category, dedupKey, dismissed=false) we
-- UPDATE occurrenceCount + lastSeenAt instead of inserting a new row.
-- occurrenceCount: how many times this dedupKey has fired since the last
-- dismiss. Default 1 on insert.
-- lastSeenAt: most-recent fire time for this dedupKey. Backfilled to createdAt
-- for existing rows.

ALTER TABLE "AdminNote" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "AdminNote" ADD COLUMN "dedupKey" TEXT;
ALTER TABLE "AdminNote" ADD COLUMN "occurrenceCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AdminNote" ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill lastSeenAt to createdAt for existing rows. The DEFAULT
-- CURRENT_TIMESTAMP above would otherwise stamp them with the migration time,
-- which lies about when the row was first observed.
UPDATE "AdminNote" SET "lastSeenAt" = "createdAt";

-- Dedup lookup index: matches the (userId, category, dedupKey, dismissed)
-- shape that upsertAdminNote() queries on every write.
CREATE INDEX "AdminNote_userId_category_dedupKey_dismissed_idx"
  ON "AdminNote" ("userId", "category", "dedupKey", "dismissed");
