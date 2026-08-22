-- BEA-1393: the self-heal loop. What broke, on the build row that tried to fix it —
-- `jobId|rule|actionId`. The two repair attempts the owner allowed are counted against this key, so
-- the same failure never re-enters the loop once it has stopped, and a different one still may.
--
-- Additive and nullable: every existing build row reads as "not a repair", which is what it is.
-- `status` gains two values (`queued`, `held`) and `origin` one (`repair`); both are plain TEXT
-- columns, so there is nothing to migrate for those.

ALTER TABLE "WorkerBuild" ADD COLUMN "cause" TEXT;
CREATE INDEX "WorkerBuild_agentId_cause_idx" ON "WorkerBuild"("agentId", "cause");
