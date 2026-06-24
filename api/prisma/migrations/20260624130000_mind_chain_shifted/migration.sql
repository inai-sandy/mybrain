-- AlterTable: dynamic Situation re-derive flag (BEA-526)
ALTER TABLE "MindChain" ADD COLUMN "shifted" BOOLEAN NOT NULL DEFAULT false;
