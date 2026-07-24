-- BEA-1081: where an imported agent came from (origin badge)
ALTER TABLE "Agent" ADD COLUMN "sourceUrl" TEXT;
