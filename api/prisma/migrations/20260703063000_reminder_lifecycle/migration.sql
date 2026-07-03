-- One-day lifecycle + notes + owner-escalation flag (BEA-764/765/766)
ALTER TABLE "Reminder" ADD COLUMN "notes" TEXT;
ALTER TABLE "Reminder" ADD COLUMN "armedDay" TEXT;
ALTER TABLE "Reminder" ADD COLUMN "pausedAuto" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Reminder" ADD COLUMN "needsOwner" BOOLEAN NOT NULL DEFAULT false;
