-- AlterTable: where a Situation chain came from (BEA-543)
ALTER TABLE "MindChain" ADD COLUMN "provenance" TEXT;
