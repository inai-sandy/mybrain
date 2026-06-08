-- Task progress (0/30/60/100) + follow-up flag for spawned follow-up tasks
ALTER TABLE "Task" ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "followUp" BOOLEAN NOT NULL DEFAULT false;
