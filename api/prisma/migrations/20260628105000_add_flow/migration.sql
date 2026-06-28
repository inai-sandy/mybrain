-- Flow canvas (BEA-644).
CREATE TABLE "Flow" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL DEFAULT 'Untitled flow',
  "question" TEXT,
  "graph" TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
