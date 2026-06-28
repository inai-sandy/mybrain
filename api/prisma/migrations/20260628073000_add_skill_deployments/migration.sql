-- Additive (BEA-634): per-target deployment tracking for skills.
ALTER TABLE "Skill" ADD COLUMN "deployments" TEXT DEFAULT '{}';
