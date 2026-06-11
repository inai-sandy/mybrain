-- The Mentor's Sunday weekly review
CREATE TABLE "WeeklyReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "weekStart" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "pattern" TEXT,
    "experiment" TEXT,
    "stats" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "WeeklyReview_weekStart_key" ON "WeeklyReview"("weekStart");
