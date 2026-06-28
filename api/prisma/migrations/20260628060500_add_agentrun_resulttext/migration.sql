-- Additive (BEA-630): the agent's final answer text, shown inline on the run.
ALTER TABLE "AgentRun" ADD COLUMN "resultText" TEXT;
