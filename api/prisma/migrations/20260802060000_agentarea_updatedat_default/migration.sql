-- BEA-1262: stop Prisma proposing to drop and recreate AgentArea on every unrelated migration.
--
-- 20260725050000_agent_areas created the table with `updatedAt DATETIME NOT NULL DEFAULT
-- CURRENT_TIMESTAMP`, but schema.prisma declares `updatedAt DateTime @updatedAt` with no default.
-- SQLite cannot drop a column default in place, so Prisma emitted this rewrite into EVERY later
-- migration -- four times in one night, each one a silent DROP TABLE of the owner's live agents,
-- stripped by hand. Doing it ONCE, deliberately, makes the history and the schema agree so it stops
-- being proposed at all.
--
-- Verified against a copy of the production database before shipping: all 10 columns are carried by
-- the INSERT...SELECT, and every row survives unchanged.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentArea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "color" TEXT,
    "description" TEXT,
    "tools" TEXT NOT NULL DEFAULT '[]',
    "outcome" TEXT,
    "sourceUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AgentArea" ("color", "createdAt", "description", "icon", "id", "name", "outcome", "sourceUrl", "tools", "updatedAt") SELECT "color", "createdAt", "description", "icon", "id", "name", "outcome", "sourceUrl", "tools", "updatedAt" FROM "AgentArea";
DROP TABLE "AgentArea";
ALTER TABLE "new_AgentArea" RENAME TO "AgentArea";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

