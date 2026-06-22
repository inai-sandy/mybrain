-- The Lab — mini mental model (BEA-446).
CREATE TABLE "MindFinding" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "statement" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "relation" TEXT NOT NULL,
  "object" TEXT NOT NULL,
  "valence" TEXT NOT NULL DEFAULT 'neutral',
  "confidence" REAL NOT NULL DEFAULT 0.2,
  "evidenceCount" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "cadence" TEXT,
  "trend" TEXT NOT NULL DEFAULT 'rising',
  "validated" TEXT,
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "firstSeenDay" TEXT NOT NULL,
  "lastSeenDay" TEXT NOT NULL,
  "supermemoryId" TEXT,
  "ragId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "MindFinding_status_idx" ON "MindFinding"("status");
CREATE TABLE "MindEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "findingId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT,
  "day" TEXT NOT NULL,
  "signal" TEXT NOT NULL,
  "snippet" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MindEvidence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "MindFinding" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MindEvidence_findingId_idx" ON "MindEvidence"("findingId");
