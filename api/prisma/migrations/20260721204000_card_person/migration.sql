-- BEA-1034: an EMO card remembers which person it was about. One nullable column, additive.

-- AlterTable
ALTER TABLE "EmoCard" ADD COLUMN "contactId" TEXT;

