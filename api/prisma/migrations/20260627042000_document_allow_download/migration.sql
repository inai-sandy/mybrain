-- AlterTable: opt-in download on a shared document (BEA-597)
ALTER TABLE "Document" ADD COLUMN "allowDownload" BOOLEAN NOT NULL DEFAULT false;
