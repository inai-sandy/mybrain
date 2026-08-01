-- AlterTable
-- BEA-1259: a hand-drawn flow Auto-plan must not rewrite.
-- Prisma wanted to DROP and recreate the whole Flow table for this (SQLite cannot alter in place
-- once a table has been rewritten before). A plain ADD COLUMN does the same job and never touches
-- the flows already saved.
ALTER TABLE "Flow" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;
