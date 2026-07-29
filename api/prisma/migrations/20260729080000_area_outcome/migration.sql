-- BEA-1173: the agent's standing definition of done. Jobs without their own Outcome — voice jobs,
-- mainly — are graded against this, so pass/fail comes free with no per-job setup.
ALTER TABLE "AgentArea" ADD COLUMN "outcome" TEXT;
