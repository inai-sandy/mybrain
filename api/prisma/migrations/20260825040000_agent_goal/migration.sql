-- BEA-1463: the goal, written by Codex from the conversation, approved by the owner.
--
-- Replaces the app-authored brief. Same purpose — "what is this agent for, and did I agree to it" —
-- but the author changes, which is the entire point: every structure the app imposed on the
-- conversation (seven sections, tagged lines, a message template with holes) produced a defect the
-- owner had to find in a real WhatsApp message.
CREATE TABLE "AgentGoal" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "areaId"     TEXT NOT NULL,
  "version"    INTEGER NOT NULL DEFAULT 1,
  "status"     TEXT NOT NULL DEFAULT 'proposed',
  "text"       TEXT NOT NULL DEFAULT '',
  "note"       TEXT,
  "tools"      TEXT NOT NULL DEFAULT '[]',
  "transcript" TEXT NOT NULL DEFAULT '[]',
  "sessionId"  TEXT,
  "approvedAt" DATETIME,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  DATETIME NOT NULL
);
CREATE INDEX "AgentGoal_areaId_status_idx"  ON "AgentGoal"("areaId", "status");
CREATE INDEX "AgentGoal_areaId_version_idx" ON "AgentGoal"("areaId", "version");
