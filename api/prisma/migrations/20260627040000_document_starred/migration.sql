-- AlterTable: star/favourite a document (BEA-596)
ALTER TABLE "Document" ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false;
