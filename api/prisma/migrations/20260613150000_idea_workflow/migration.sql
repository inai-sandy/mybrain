-- Saved agentic workflow per idea
CREATE TABLE "IdeaWorkflow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ideaId" TEXT,
    "name" TEXT NOT NULL DEFAULT 'Workflow',
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "nodes" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "IdeaWorkflow_ideaId_key" ON "IdeaWorkflow"("ideaId");
