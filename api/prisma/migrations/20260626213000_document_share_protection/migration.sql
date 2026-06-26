-- AlterTable: password + expiry protection for shared documents (BEA-585)
ALTER TABLE "Document" ADD COLUMN "sharePassword" TEXT;
ALTER TABLE "Document" ADD COLUMN "expiresAt" DATETIME;
