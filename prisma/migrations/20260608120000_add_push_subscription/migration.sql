-- Web Push subscriptions live in the DB so admins can add/remove devices
-- without editing .env and restarting. Replaces the legacy
-- PUSH_SUBSCRIPTION_JSON env var; notifyAdmin() now reads from this table
-- and auto-prunes endpoints the push service rejects with 404/410.
--
-- endpoint is the push service URL — the unique identity of a subscription
-- across resubscribes from the same install — so we upsert by it.

CREATE TABLE "PushSubscription" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "endpoint"       TEXT NOT NULL,
  "p256dh"         TEXT NOT NULL,
  "auth"           TEXT NOT NULL,
  "userAgent"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastNotifiedAt" TIMESTAMP(3),

  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription" ("endpoint");

CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription" ("userId");

ALTER TABLE "PushSubscription"
  ADD CONSTRAINT "PushSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
