-- AlterTable (BEA-1374): "keep adding" — one sheet, created on the first run, then appended to
ALTER TABLE "Agent" ADD COLUMN "sheetAppend" BOOLEAN NOT NULL DEFAULT false;
