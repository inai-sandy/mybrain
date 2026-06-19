-- Proactive Connections: links the brain surfaces on its own. (BEA-357)
CREATE TABLE "Connection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "summary" TEXT NOT NULL,
  "items" TEXT NOT NULL,
  "score" REAL NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'new',
  "anchorKey" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
