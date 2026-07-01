-- Live terminal / play-by-play for a flow run (workspace ②)
ALTER TABLE "FlowRun" ADD COLUMN "terminal" TEXT NOT NULL DEFAULT '[]';
