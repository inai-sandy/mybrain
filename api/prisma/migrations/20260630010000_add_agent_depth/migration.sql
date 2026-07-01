-- BEA-695: agent run depth model
ALTER TABLE "Agent" ADD COLUMN "defaultDepth" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "AgentRun" ADD COLUMN "depth" TEXT;
