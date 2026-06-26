-- AlterTable: count public opens of a shared document (BEA-586)
ALTER TABLE "Document" ADD COLUMN "viewCount" INTEGER NOT NULL DEFAULT 0;
