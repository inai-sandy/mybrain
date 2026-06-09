-- Quick-capture notes (Google Keep style), local only.
CREATE TABLE "Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "content" TEXT,
    "checklist" TEXT,
    "color" TEXT NOT NULL DEFAULT 'default',
    "tags" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "Note_archived_pinned_idx" ON "Note"("archived", "pinned");
