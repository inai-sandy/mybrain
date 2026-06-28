-- Additive (BEA-642): saved eval cases per agent (regression check).
ALTER TABLE "Agent" ADD COLUMN "evals" TEXT NOT NULL DEFAULT '[]';
