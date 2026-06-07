-- CreateTable
CREATE TABLE "PersonalityInsight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "dimension" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
