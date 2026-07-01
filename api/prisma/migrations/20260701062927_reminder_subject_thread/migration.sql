-- Reminder: add subject (the {{2}} "what you're chasing")
ALTER TABLE "Reminder" ADD COLUMN "subject" TEXT;

-- ReminderSend: add error column (delivered/read/failed reuse the existing status string)
ALTER TABLE "ReminderSend" ADD COLUMN "error" TEXT;

-- ReminderMessage: the WhatsApp conversation thread per reminder
CREATE TABLE "ReminderMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reminderId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "wamid" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReminderMessage_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ReminderMessage_reminderId_idx" ON "ReminderMessage"("reminderId");
