-- AlterTable (BEA-1355): the honest per-call cost, read off the provider's answer
ALTER TABLE "ToolCall" ADD COLUMN "credits" INTEGER;
