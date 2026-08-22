-- BEA-1394 (agent workers 9/10): the dispatch switch, and what a run really cost.
--
-- `Agent.useWorker` is the switch nobody owned until now. A promoted worker has been installed and
-- INERT since BEA-1390; from here a run takes the worker road only when the job has a promoted
-- worker AND this is on. Default false, so every existing job keeps running exactly as it does
-- today — nothing converts automatically, ever.
--
-- `AgentRun.aiTokens` is the per-run AI spend. Credits already roll up from the `ToolCall` rows that
-- carry the run's id; token usage is logged per FEATURE with no run on it, so each road adds what it
-- measured. 0 on every existing row is the truth: nothing was counted before this.

ALTER TABLE "Agent" ADD COLUMN "useWorker" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentRun" ADD COLUMN "aiTokens" INTEGER NOT NULL DEFAULT 0;
