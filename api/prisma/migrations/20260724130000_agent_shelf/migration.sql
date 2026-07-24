-- BEA-1087: the Agents home shelf — category grouping + card colour
ALTER TABLE "Agent" ADD COLUMN "category" TEXT;
ALTER TABLE "Agent" ADD COLUMN "color" TEXT;
