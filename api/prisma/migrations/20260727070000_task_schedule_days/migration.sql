-- BEA-1147: a recurring report is owed on its OWN days, not every day.
ALTER TABLE "Task" ADD COLUMN "scheduleDays" TEXT;
