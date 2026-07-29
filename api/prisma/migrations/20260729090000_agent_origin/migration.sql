-- BEA-1175/1176: how a job was created, so the agent page can label it (chat / voice / import).
ALTER TABLE "Agent" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'chat';
