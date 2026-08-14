-- BEA-1309 — messages can no longer outlive the person they belong to.
--
-- `ReminderMessage.contactId` was a bare column with no foreign key, and a conversation only
-- surfaces in the Chats inbox through a live Reminder. So deleting a contact cascaded their
-- reminders away and left the messages behind, pointing at an id that no longer existed:
-- unreachable by any screen and undeletable by any code.
--
-- The orphans already in the database are removed FIRST. Adding the constraint on top of rows that
-- violate it is how a migration succeeds and leaves the table quietly broken.
--
-- This is a RedefineTables migration — SQLite cannot add a foreign key any other way. The generated
-- column list below was checked against the live table: all 11 columns are carried across, and the
-- whole thing was rehearsed on a copy of production before shipping.
DELETE FROM "ReminderMessage"
 WHERE "contactId" IS NOT NULL
   AND "contactId" NOT IN (SELECT "id" FROM "Contact");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReminderMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT,
    "reminderId" TEXT,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "wamid" TEXT,
    "status" TEXT,
    "error" TEXT,
    "replyToWamid" TEXT,
    "buttonId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReminderMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReminderMessage_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ReminderMessage" ("body", "buttonId", "contactId", "createdAt", "direction", "error", "id", "reminderId", "replyToWamid", "status", "wamid") SELECT "body", "buttonId", "contactId", "createdAt", "direction", "error", "id", "reminderId", "replyToWamid", "status", "wamid" FROM "ReminderMessage";
DROP TABLE "ReminderMessage";
ALTER TABLE "new_ReminderMessage" RENAME TO "ReminderMessage";
CREATE INDEX "ReminderMessage_contactId_idx" ON "ReminderMessage"("contactId");
CREATE INDEX "ReminderMessage_reminderId_idx" ON "ReminderMessage"("reminderId");
CREATE INDEX "ReminderMessage_wamid_idx" ON "ReminderMessage"("wamid");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

