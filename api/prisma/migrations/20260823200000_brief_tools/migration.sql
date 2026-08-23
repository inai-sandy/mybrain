-- Actions a brief's agent may USE beyond its sources (BEA-1453) — writing, messaging.
ALTER TABLE "AgentBrief" ADD COLUMN "tools" TEXT NOT NULL DEFAULT '[]';
