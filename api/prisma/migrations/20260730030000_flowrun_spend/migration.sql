-- What a run actually spent on search, so the owner reads the real cost off the run (BEA-1196).
ALTER TABLE "FlowRun" ADD COLUMN "spend" TEXT;
