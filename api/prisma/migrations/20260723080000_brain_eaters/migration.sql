-- Brain Eaters (BEA-1056): the items that circle the owner's head and keep getting skipped.
-- A flag, not a new table — they are real tasks with a special home and a loud finish.
ALTER TABLE "Task" ADD COLUMN "brainEater" BOOLEAN NOT NULL DEFAULT 0;
