-- When it runs, carried from the brief onto the agent (BEA-1454). "10PM" used to be dropped.
ALTER TABLE "AgentBrief" ADD COLUMN "schedule" TEXT;
