-- Dead links used to be retried (and paid for) on every hourly sync forever. Count the failed
-- tries so the sync can give up at a cap. Existing readFailed rows start AT the cap: they have
-- already been retried hourly for weeks — no need to pay for five more goes. (BEA-841)
ALTER TABLE "Item" ADD COLUMN "readAttempts" INTEGER NOT NULL DEFAULT 0;
UPDATE "Item" SET "readAttempts" = 5 WHERE "readFailed" = 1;
