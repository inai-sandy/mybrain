-- CreateTable
CREATE TABLE "EmoDeviceReminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "EmoDeviceReminder_status_dueAt_idx" ON "EmoDeviceReminder"("status", "dueAt");
