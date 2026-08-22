-- BEA-1387: the run journal, and which road a run is on.
-- Additive only: one new table, one new column with a default that matches every existing row.

CREATE TABLE "RunJournal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "stepKey" TEXT NOT NULL,
    "fn" TEXT NOT NULL,
    "result" BLOB NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "RunJournal_runId_seq_key" ON "RunJournal"("runId", "seq");
CREATE INDEX "RunJournal_runId_idx" ON "RunJournal"("runId");

-- Every run that exists today ran on the engine or the plan runner, and both are safe to sweep the
-- way they are swept today: 'engine' is the value that keeps behaviour identical for old rows.
ALTER TABLE "AgentRun" ADD COLUMN "runKind" TEXT NOT NULL DEFAULT 'engine';
