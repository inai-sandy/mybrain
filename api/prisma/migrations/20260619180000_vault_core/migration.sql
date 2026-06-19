-- Vault zero-knowledge core: ciphertext-only storage. (BEA-345)
CREATE TABLE "VaultMeta" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kdfParams" TEXT NOT NULL,
  "salt" TEXT NOT NULL,
  "verifier" TEXT NOT NULL,
  "wrapPass" TEXT NOT NULL,
  "wrapRecovery" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "VaultItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "type" TEXT NOT NULL,
  "blob" TEXT NOT NULL,
  "title" TEXT,
  "website" TEXT,
  "username" TEXT,
  "tags" TEXT,
  "cardType" TEXT,
  "bankName" TEXT,
  "collection" TEXT,
  "favorite" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "VaultItem_type_idx" ON "VaultItem"("type");
CREATE INDEX "VaultItem_collection_idx" ON "VaultItem"("collection");
