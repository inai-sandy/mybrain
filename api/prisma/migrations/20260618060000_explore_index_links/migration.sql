-- Explore index: link rows to their store docs so re-index replaces (no dupes),
-- and let the outbox back-reference the right table (not just Item). (BEA-331)
-- AlterTable
ALTER TABLE "Task" ADD COLUMN "ragId" TEXT;
ALTER TABLE "Task" ADD COLUMN "supermemoryId" TEXT;
-- AlterTable
ALTER TABLE "Story" ADD COLUMN "ragId" TEXT;
ALTER TABLE "Story" ADD COLUMN "supermemoryId" TEXT;
-- AlterTable
ALTER TABLE "MemoryOutbox" ADD COLUMN "refType" TEXT;
