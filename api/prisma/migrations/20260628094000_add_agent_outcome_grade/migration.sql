-- Additive (BEA-641): an agent's Outcome (definition of done) + per-run grade.
ALTER TABLE "Agent" ADD COLUMN "rubric" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "grade" TEXT;
