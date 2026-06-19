-- Accountability brain: commitments + decisions extracted from the day. (BEA-355)
CREATE TABLE "Commitment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "text" TEXT NOT NULL,
  "party" TEXT,
  "dueDate" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "source" TEXT NOT NULL DEFAULT 'story',
  "sourceDay" TEXT NOT NULL,
  "confirmed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME
);
CREATE TABLE "Decision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "text" TEXT NOT NULL,
  "context" TEXT,
  "source" TEXT NOT NULL DEFAULT 'story',
  "sourceDay" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
