-- AlterTable: short share code for documents -> /s/:code (BEA-584)
ALTER TABLE "Document" ADD COLUMN "shortCode" TEXT;

-- CreateIndex (SQLite allows multiple NULLs under a unique index)
CREATE UNIQUE INDEX "Document_shortCode_key" ON "Document"("shortCode");
