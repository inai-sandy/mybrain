-- Flow execution (BEA-646).
CREATE TABLE "FlowRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "flowId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'running',
  "results" TEXT NOT NULL DEFAULT '{}',
  "finalOutput" TEXT,
  "error" TEXT,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" DATETIME
);
