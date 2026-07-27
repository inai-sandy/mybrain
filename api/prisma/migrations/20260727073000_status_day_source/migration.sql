-- BEA-1152: a later message beats an earlier tick, so the ledger records WHICH signal and WHEN.
ALTER TABLE "TaskStatusDay" ADD COLUMN "source" TEXT;
ALTER TABLE "TaskStatusDay" ADD COLUMN "signalAt" DATETIME;
UPDATE "TaskStatusDay" SET "signalAt" = "createdAt" WHERE "signalAt" IS NULL;
