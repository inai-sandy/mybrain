-- AddColumn
ALTER TABLE "ReminderMessage" ADD COLUMN "status" TEXT;
ALTER TABLE "ReminderMessage" ADD COLUMN "error" TEXT;

-- CreateIndex
CREATE INDEX "ReminderMessage_wamid_idx" ON "ReminderMessage"("wamid");
