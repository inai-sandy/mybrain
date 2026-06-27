-- AlterTable: who a task is a promise to/with (folded in from Commitments) (BEA-604)
ALTER TABLE "Task" ADD COLUMN "party" TEXT;
