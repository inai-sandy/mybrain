-- BEA-1388: the per-job run lock — one run at a time.
-- Additive only: one new table. Nothing existing changes, so every live agent keeps firing exactly
-- as it does today; the lock is empty until the first run claims it.

CREATE TABLE "JobRunLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "runId" TEXT,
    "reason" TEXT,
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- The uniqueness IS the claim: two starts of one job race on this index and exactly one INSERT wins.
CREATE UNIQUE INDEX "JobRunLock_jobId_key" ON "JobRunLock"("jobId");
CREATE INDEX "JobRunLock_expiresAt_idx" ON "JobRunLock"("expiresAt");
