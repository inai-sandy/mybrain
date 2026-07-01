-- BEA-719/720: WhatsApp Reminders — contacts, reminders, scheduled sends
CREATE TABLE "Contact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "whatsappNumber" TEXT,
  "notes" TEXT,
  "tags" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "Contact_name_idx" ON "Contact"("name");

CREATE TABLE "Reminder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "contactId" TEXT NOT NULL,
  "taskId" TEXT,
  "message" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "times" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'active',
  "feedback" TEXT,
  "lastFiredKey" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Reminder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Reminder_contactId_idx" ON "Reminder"("contactId");
CREATE INDEX "Reminder_status_idx" ON "Reminder"("status");

CREATE TABLE "ReminderSend" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reminderId" TEXT NOT NULL,
  "at" DATETIME NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "providerId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReminderSend_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ReminderSend_reminderId_idx" ON "ReminderSend"("reminderId");
CREATE INDEX "ReminderSend_status_idx" ON "ReminderSend"("status");
