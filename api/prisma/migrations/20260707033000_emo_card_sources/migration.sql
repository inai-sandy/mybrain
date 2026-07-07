-- AlterTable: structured cited sources on EMO cards (BEA-907)
ALTER TABLE "EmoCard" ADD COLUMN "sources" TEXT NOT NULL DEFAULT '[]';
