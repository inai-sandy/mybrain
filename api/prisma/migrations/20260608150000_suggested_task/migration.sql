-- Predicted tasks proposed by the Story of the Day, approved with "+"
CREATE TABLE "SuggestedTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "forDay" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SuggestedTask_forDay_idx" ON "SuggestedTask"("forDay");
