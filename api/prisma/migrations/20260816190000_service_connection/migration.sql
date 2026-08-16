-- CreateTable
CREATE TABLE "ServiceConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "service" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceConnection_connectedAccountId_key" ON "ServiceConnection"("connectedAccountId");

-- CreateIndex
CREATE INDEX "ServiceConnection_service_idx" ON "ServiceConnection"("service");
