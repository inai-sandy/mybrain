-- BEA-1027: each contact gets their own short link to their task list.
-- Additive: two nullable/defaulted columns on Contact. Every existing column is carried across.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "whatsappNumber" TEXT,
    "notes" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "aliases" TEXT NOT NULL DEFAULT '[]',
    "lastReadAt" DATETIME,
    "shareSlug" TEXT,
    "shareEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Contact" ("aliases", "createdAt", "id", "lastReadAt", "name", "notes", "tags", "updatedAt", "whatsappNumber") SELECT "aliases", "createdAt", "id", "lastReadAt", "name", "notes", "tags", "updatedAt", "whatsappNumber" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE UNIQUE INDEX "Contact_shareSlug_key" ON "Contact"("shareSlug");
CREATE INDEX "Contact_name_idx" ON "Contact"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

