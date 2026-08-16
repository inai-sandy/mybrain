-- Chat can use connected services (BEA-1349).
-- Two nullable columns, so every message written before this stays exactly as it was.
ALTER TABLE "ChatMessage" ADD COLUMN "tools" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "gate" TEXT;
