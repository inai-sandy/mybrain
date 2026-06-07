-- CreateTable
CREATE TABLE "DaySummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "day" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "stats" TEXT,
    "supermemoryId" TEXT,
    "ragId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "DaySummary_day_key" ON "DaySummary"("day");
