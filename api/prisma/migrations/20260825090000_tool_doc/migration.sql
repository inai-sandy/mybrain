-- BEA-1468: one durable document per connected tool, listing every action it has.
--
-- What Codex knew about a tool used to be assembled live, thrown away, and chosen by the app. These
-- rows are permanent and cover everything connected, so a build can reach for an action nobody
-- thought to hand it — which is the whole reason the owner asked for them.
CREATE TABLE "ToolDoc" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "service"   TEXT NOT NULL,
  "name"      TEXT NOT NULL DEFAULT '',
  "actions"   INTEGER NOT NULL DEFAULT 0,
  "text"      TEXT NOT NULL DEFAULT '',
  "hash"      TEXT NOT NULL DEFAULT '',
  "builtAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ToolDoc_service_key" ON "ToolDoc"("service");
