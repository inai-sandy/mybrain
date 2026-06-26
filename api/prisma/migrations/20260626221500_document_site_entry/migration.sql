-- AlterTable: entry html path for multi-file ZIP sites (BEA-587)
ALTER TABLE "Document" ADD COLUMN "siteEntry" TEXT;
