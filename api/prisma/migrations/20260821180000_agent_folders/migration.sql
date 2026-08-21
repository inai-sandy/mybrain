-- BEA-1380: flat folders for the Agents home. Additive only — no existing row is touched.
CREATE TABLE "AgentFolder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "AgentArea" ADD COLUMN "folderId" TEXT;
