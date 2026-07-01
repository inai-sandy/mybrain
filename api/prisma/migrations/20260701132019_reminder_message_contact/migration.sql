-- ReminderMessage: add contactId (per-contact conversation), make reminderId nullable w/ SetNull. (BEA-742)
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReminderMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT,
    "reminderId" TEXT,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "wamid" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReminderMessage_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ReminderMessage" ("id","reminderId","direction","body","wamid","createdAt")
    SELECT "id","reminderId","direction","body","wamid","createdAt" FROM "ReminderMessage";
UPDATE "new_ReminderMessage" SET "contactId" = (SELECT "contactId" FROM "Reminder" WHERE "Reminder"."id" = "new_ReminderMessage"."reminderId");
DROP TABLE "ReminderMessage";
ALTER TABLE "new_ReminderMessage" RENAME TO "ReminderMessage";
CREATE INDEX "ReminderMessage_contactId_idx" ON "ReminderMessage"("contactId");
CREATE INDEX "ReminderMessage_reminderId_idx" ON "ReminderMessage"("reminderId");
PRAGMA foreign_keys=ON;
