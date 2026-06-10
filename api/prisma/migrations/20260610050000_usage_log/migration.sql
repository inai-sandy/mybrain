-- Per-request AI cost log
CREATE TABLE "UsageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "cost" REAL
);
CREATE INDEX "UsageLog_at_idx" ON "UsageLog"("at");
CREATE INDEX "UsageLog_feature_idx" ON "UsageLog"("feature");
