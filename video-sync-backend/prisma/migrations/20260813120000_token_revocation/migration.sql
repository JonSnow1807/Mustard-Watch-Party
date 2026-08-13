-- Token revocation: a way to stop trusting a token before it expires.
--
-- Two levers, because they answer different questions. tokenVersion is
-- "distrust everything this user holds" - one integer, every session gone.
-- RevokedToken is "distrust this one session" - what an ordinary sign-out
-- writes.

-- Additive with a default and NOT NULL: a catalog change in PostgreSQL 11+,
-- not a table rewrite, so existing rows are untouched and nobody waits.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "RevokedToken" (
    "jti" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevokedToken_pkey" PRIMARY KEY ("jti")
);

-- The sweep deletes by expiry; nothing on the request path reads this table
-- (the guard consults an in-memory snapshot), so these two serve the sweep
-- and the cascade rather than any hot query.
CREATE INDEX "RevokedToken_expiresAt_idx" ON "RevokedToken"("expiresAt");
CREATE INDEX "RevokedToken_userId_idx" ON "RevokedToken"("userId");

-- ON DELETE CASCADE: deleting a user should not be blocked by rows that
-- exist only to distrust that user's tokens. The guest sweeper deletes
-- users, and RESTRICT here would make it fail on anyone who had signed out.
ALTER TABLE "RevokedToken" ADD CONSTRAINT "RevokedToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
