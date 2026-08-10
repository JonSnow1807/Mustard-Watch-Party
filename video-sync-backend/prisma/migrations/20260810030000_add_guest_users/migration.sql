-- Guests: someone who followed an invite link without registering.
--
-- Additive and safe on a live database: a new column with a default and
-- NOT NULL is a catalog change in PostgreSQL 11+, not a table rewrite, so
-- existing rows are untouched and nobody waits.

ALTER TABLE "User" ADD COLUMN "isGuest" BOOLEAN NOT NULL DEFAULT false;

-- The sweeper looks up guests by age; without this it is a sequential scan
-- over every user in the table on every run.
CREATE INDEX "User_isGuest_createdAt_idx" ON "User"("isGuest", "createdAt");
