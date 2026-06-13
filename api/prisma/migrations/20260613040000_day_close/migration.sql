-- A sealed/closed day
CREATE TABLE "DayClose" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "day" TEXT NOT NULL,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "DayClose_day_key" ON "DayClose"("day");
