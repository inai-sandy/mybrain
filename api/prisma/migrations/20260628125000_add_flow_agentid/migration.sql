-- Link a flow to the agent that generated it (Agent↔Flow merge ①)
ALTER TABLE "Flow" ADD COLUMN "agentId" TEXT;
