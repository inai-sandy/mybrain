-- AlterTable (BEA-1357): Google Sheet as an output destination + the pinned arguments of a direct-fetch job
ALTER TABLE "Agent" ADD COLUMN "sheetId" TEXT;
ALTER TABLE "Agent" ADD COLUMN "toolArgs" TEXT;
-- AlterTable (BEA-1357): the outside link a run produced (the sheet it wrote)
ALTER TABLE "AgentRun" ADD COLUMN "outputUrl" TEXT;
