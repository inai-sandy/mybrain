-- BEA-1031: Briefing and Contact become brain sources, so they need the doc-id columns every
-- other indexed table has — without them a re-index would pile up duplicates. Additive.

-- AlterTable
ALTER TABLE "Briefing" ADD COLUMN "ragId" TEXT;
ALTER TABLE "Briefing" ADD COLUMN "supermemoryId" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "ragId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "supermemoryId" TEXT;

