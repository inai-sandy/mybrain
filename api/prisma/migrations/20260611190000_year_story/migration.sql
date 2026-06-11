-- Story of the Year
CREATE TABLE "YearStory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year" TEXT NOT NULL,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "YearStory_year_key" ON "YearStory"("year");
