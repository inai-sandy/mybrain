-- CreateTable
CREATE TABLE "MindRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "day" TEXT,
    "detail" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "MindRun_at_idx" ON "MindRun"("at");
