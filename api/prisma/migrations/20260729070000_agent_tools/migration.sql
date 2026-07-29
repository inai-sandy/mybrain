-- BEA-1168: the tool ids a job is allowed to use. Empty means "inherit the agent's toolbox".
ALTER TABLE "Agent" ADD COLUMN "tools" TEXT NOT NULL DEFAULT '[]';
