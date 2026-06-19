-- Vault per-item audit trail (timestamps + action only, never the value). (BEA-353)
CREATE TABLE "VaultAudit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "itemId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "VaultAudit_itemId_idx" ON "VaultAudit"("itemId");
