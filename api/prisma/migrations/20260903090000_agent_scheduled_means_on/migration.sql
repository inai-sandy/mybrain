-- BEA-1603: a schedule on an agent means it is ON.
--
-- A goal-built agent is born off and only "Keep it" switched it on. His Daily Email Agent's first
-- run failed, so that question was never asked, and the "every day at 23:00" he then saved sat on
-- a switch that was off. Nobody sets a time for a thing they want to stay off.
--
-- One pass, safe to run more than once: every agent that is off, was NOT paused by the system
-- (pausedReason IS NULL), and has a schedule, is switched on. On 2026-09-03 that is exactly one
-- row (the Daily Email Agent). An agent with no schedule stays off; a system pause is kept.
UPDATE "Agent" SET "enabled" = 1 WHERE "enabled" = 0 AND "pausedReason" IS NULL AND "schedule" IS NOT NULL;
