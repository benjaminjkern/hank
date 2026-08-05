-- Auth.js (NextAuth v5) tables for multi-user + session auth. Adds User profile
-- columns the adapter expects and the three standard adapter tables:
-- Account (OAuth links), Session (DB-backed sessions), VerificationToken
-- (magic-link tokens).

ALTER TABLE "User"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "image" TEXT,
  ADD COLUMN "emailVerified" TIMESTAMP(3);

CREATE TABLE "Account" (
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "refresh_token" TEXT,
  "access_token" TEXT,
  "expires_at" INTEGER,
  "token_type" TEXT,
  "scope" TEXT,
  "id_token" TEXT,
  "session_state" TEXT,

  CONSTRAINT "Account_pkey" PRIMARY KEY ("provider", "providerAccountId")
);

CREATE INDEX "Account_userId_idx" ON "Account"("userId");

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Session" (
  "sessionToken" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expires" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Session_pkey" PRIMARY KEY ("sessionToken")
);

CREATE INDEX "Session_userId_idx" ON "Session"("userId");

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "VerificationToken" (
  "identifier" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "expires" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("identifier", "token")
);
