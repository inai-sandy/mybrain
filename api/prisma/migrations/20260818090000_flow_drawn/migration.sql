-- AlterTable (BEA-1366): who drew a flow's picture + the state of the last (re-)draw
ALTER TABLE "Flow" ADD COLUMN "drawnBy" TEXT;
ALTER TABLE "Flow" ADD COLUMN "drawStatus" TEXT;
ALTER TABLE "Flow" ADD COLUMN "drawNote" TEXT;
